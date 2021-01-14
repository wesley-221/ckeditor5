/**
 * @license Copyright (c) 2003-2020, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module clipboard/clipboard
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import PastePlainText from './pasteplaintext';

import ClipboardObserver from './clipboardobserver';

import plainTextToHtml from './utils/plaintexttohtml';
import normalizeClipboardHtml from './utils/normalizeclipboarddata';
import viewToPlainText from './utils/viewtoplaintext.js';

import EventInfo from '@ckeditor/ckeditor5-utils/src/eventinfo';
import LiveRange from '@ckeditor/ckeditor5-engine/src/model/liverange';
import MouseObserver from '@ckeditor/ckeditor5-engine/src/view/observer/mouseobserver';
import env from '@ckeditor/ckeditor5-utils/src/env';
import { isWidget } from '@ckeditor/ckeditor5-widget/src/utils';
import { throttle } from 'lodash-es';

import '../theme/clipboard.css';

/**
 * The clipboard feature. It is responsible for intercepting the `paste` and `drop` events and
 * passing the pasted content through the clipboard pipeline in order to insert it into the editor's content.
 * It also handles the `cut` and `copy` events to fill the native clipboard with serialized editor's data.
 *
 * Read more about the clipboard integration in {@glink framework/guides/deep-dive/clipboard "Clipboard" deep dive} guide.
 *
 * @extends module:core/plugin~Plugin
 */
export default class Clipboard extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'Clipboard';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ PastePlainText ];
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;
		const view = editor.editing.view;

		/**
		 * TODO
		 * @private
		 */
		this._draggedRange = null;

		/**
		 * TODO
		 * @private
		 */
		this._draggableElement = null;

		view.addObserver( ClipboardObserver );
		view.addObserver( MouseObserver );

		this._setupPasteDrop();
		this._setupCopyCut();
		this._setupDragging();
	}

	/**
	 * @inheritDoc
	 */
	destroy() {
		if ( this._draggedRange ) {
			this._draggedRange.detach();
			this._draggedRange = null;
		}

		this._updateMarkersThrottled.cancel();

		return super.destroy();
	}

	// The clipboard paste pipeline.
	_setupPasteDrop() {
		const editor = this.editor;
		const view = editor.editing.view;
		const viewDocument = view.document;

		// Pasting and dropping is disabled when editor is read-only.
		// See: https://github.com/ckeditor/ckeditor5-clipboard/issues/26.
		this.listenTo( viewDocument, 'clipboardInput', evt => {
			if ( editor.isReadOnly ) {
				evt.stop();
			}
		}, { priority: 'highest' } );

		this.listenTo( viewDocument, 'clipboardInput', ( evt, data ) => {
			const selection = editor.model.document.selection;
			const dataTransfer = data.dataTransfer;
			let content = '';

			if ( dataTransfer.getData( 'text/html' ) ) {
				content = normalizeClipboardHtml( dataTransfer.getData( 'text/html' ) );
			} else if ( dataTransfer.getData( 'text/plain' ) ) {
				content = plainTextToHtml( dataTransfer.getData( 'text/plain' ) );
			}

			if ( data.method == 'drop' ) {
				const targetRange = findDropTargetRange( editor, data.targetRanges, data.target );

				if ( targetRange ) {
					editor.model.change( writer => {
						writer.setSelection( targetRange );
					} );
				} else {
					this._finalizeDragging( false );

					return;
				}

				// Don't do anything if some content was dragged within the same document to the same position.
				if ( this._draggedRange && this._draggedRange.containsRange( selection.getFirstRange(), true ) ) {
					this._finalizeDragging( false );

					return;
				}
			}

			content = this.editor.data.htmlProcessor.toView( content );

			const eventInfo = new EventInfo( this, 'inputTransformation' );
			this.fire( eventInfo, {
				content,
				dataTransfer,
				asPlainText: data.asPlainText
			} );

			// If CKEditor handled the input, do not bubble the original event any further.
			// This helps external integrations recognize that fact and act accordingly.
			// https://github.com/ckeditor/ckeditor5-upload/issues/92
			if ( eventInfo.stop.called ) {
				evt.stop();
			}

			view.scrollToTheSelection();
		}, { priority: 'low' } );

		this.listenTo( this, 'inputTransformation', ( evt, data ) => {
			if ( !data.content.isEmpty ) {
				const dataController = this.editor.data;
				const model = this.editor.model;
				const selection = model.document.selection;

				// Convert the pasted content to a model document fragment.
				// Conversion is contextual, but in this case we need an "all allowed" context and for that
				// we use the $clipboardHolder item.
				const modelFragment = dataController.toModel( data.content, '$clipboardHolder' );

				if ( modelFragment.childCount == 0 ) {
					return;
				}

				model.change( writer => {
					// Remove dragged content from it's original position.
					const dropEffect = env.isGecko ? data.dataTransfer.dropEffect : data.dataTransfer.effectAllowed;

					// TODO this should be handled only in dragend if it will work correctly (and the above check would not be needed).
					this._finalizeDragging( [ 'move', 'copyMove' ].includes( dropEffect ) );

					// Plain text can be determined based on event flag (#7799) or auto detection (#1006). If detected
					// preserve selection attributes on pasted items.
					if ( data.asPlainText || isPlainTextFragment( modelFragment, model.schema ) ) {
						// Formatting attributes should be preserved.
						const textAttributes = Array.from( selection.getAttributes() )
							.filter( ( [ key ] ) => model.schema.getAttributeProperties( key ).isFormatting );

						if ( !selection.isCollapsed ) {
							model.deleteContent( selection, { doNotAutoparagraph: true } );
						}

						// But also preserve other attributes if they survived the content deletion (because they were not fully selected).
						// For example linkHref is not a formatting attribute but it should be preserved if pasted text was in the middle
						// of a link.
						textAttributes.push( ...selection.getAttributes() );

						const range = writer.createRangeIn( modelFragment );

						for ( const item of range.getItems() ) {
							if ( item.is( '$text' ) || item.is( '$textProxy' ) ) {
								writer.setAttributes( textAttributes, item );
							}
						}
					}

					model.insertContent( modelFragment );
				} );

				evt.stop();
			}
		}, { priority: 'low' } );
	}

	// The clipboard copy/cut pipeline.
	_setupCopyCut() {
		const editor = this.editor;
		const modelDocument = editor.model.document;
		const view = editor.editing.view;
		const viewDocument = view.document;

		function onCopyCut( evt, data ) {
			const dataTransfer = data.dataTransfer;

			data.preventDefault();

			const content = editor.data.toView( editor.model.getSelectedContent( modelDocument.selection ) );

			viewDocument.fire( 'clipboardOutput', { dataTransfer, content, method: evt.name } );
		}

		this.listenTo( viewDocument, 'copy', onCopyCut, { priority: 'low' } );
		this.listenTo( viewDocument, 'cut', ( evt, data ) => {
			// Cutting is disabled when editor is read-only.
			// See: https://github.com/ckeditor/ckeditor5-clipboard/issues/26.
			if ( editor.isReadOnly ) {
				data.preventDefault();
			} else {
				onCopyCut( evt, data );
			}
		}, { priority: 'low' } );

		this.listenTo( viewDocument, 'clipboardOutput', ( evt, data ) => {
			if ( !data.content.isEmpty ) {
				data.dataTransfer.setData( 'text/html', this.editor.data.htmlProcessor.toData( data.content ) );
				data.dataTransfer.setData( 'text/plain', viewToPlainText( data.content ) );
			}

			if ( data.method == 'cut' ) {
				editor.model.deleteContent( modelDocument.selection );
			}
		}, { priority: 'low' } );
	}

	// Drag & drop handling.
	_setupDragging() {
		const editor = this.editor;
		const modelDocument = editor.model.document;
		const view = editor.editing.view;
		const viewDocument = view.document;

		this.listenTo( viewDocument, 'dragstart', ( evt, data ) => {
			const selection = modelDocument.selection;
			const domConverter = editor.editing.view.domConverter;

			// Don't start dragging if nothing is selected.
			if ( selection.isCollapsed ) {
				data.preventDefault();

				return;
			}

			// Don't drag editable element.
			if ( data.domTarget.nodeType == 1 && domConverter.mapDomToView( data.domTarget ).is( 'rootElement' ) ) {
				data.preventDefault();

				return;
			}

			// TODO we could clone this node somewhere and style it to match editing view but without handles,
			//  selection outline, WTA buttons, etc.
			// data.dataTransfer._native.setDragImage( data.domTarget, 0, 0 );

			data.dataTransfer.effectAllowed = 'copyMove';

			const content = editor.data.toView( editor.model.getSelectedContent( modelDocument.selection ) );

			this._draggedRange = LiveRange.fromRange( modelDocument.selection.getFirstRange() );

			viewDocument.fire( 'clipboardOutput', { dataTransfer: data.dataTransfer, content, method: evt.name } );
		}, { priority: 'low' } );

		// TODO this is not fired if source text node got removed while downcasting marker
		//  (it's not possible to move to other editor, only copy).
		this.listenTo( viewDocument, 'dragend', ( evt, data ) => {
			this._finalizeDragging( !data.dataTransfer.isCanceled && data.dataTransfer.dropEffect == 'move' );
		}, { priority: 'low' } );

		this.listenTo( viewDocument, 'dragenter', () => {
			view.focus();
		} );

		this.listenTo( viewDocument, 'dragleave', ( evt, data ) => {
			// TODO in Safari there is no relatedTarget while dragging over the text.
			if ( !data.relatedTarget ) {
				this._removeDraggingMarkers();
			}
		} );

		this.listenTo( viewDocument, 'dragging', ( evt, data ) => {
			if ( editor.isReadOnly ) {
				data.dataTransfer.dropEffect = 'none';

				return;
			}

			const targetRange = findDropTargetRange( editor, data.targetRanges, data.target );

			if ( targetRange ) {
				this._updateMarkersThrottled( targetRange );
			} else {
				data.dataTransfer.dropEffect = 'none';
			}
		}, { priority: 'low' } );

		this._updateMarkersThrottled = throttle( targetRange => {
			const editor = this.editor;

			editor.model.change( writer => {
				const markerName = `drop-target:${ targetRange.isCollapsed ? 'position' : 'range' }`;
				const otherMarkerName = `drop-target:${ !targetRange.isCollapsed ? 'position' : 'range' }`;

				if ( editor.model.markers.has( markerName ) ) {
					if ( !editor.model.markers.get( markerName ).getRange().isEqual( targetRange ) ) {
						writer.updateMarker( markerName, { range: targetRange } );
					}
				} else {
					if ( editor.model.markers.has( otherMarkerName ) ) {
						writer.removeMarker( otherMarkerName );
					}

					writer.addMarker( markerName, {
						range: targetRange,
						usingOperation: false,
						affectsData: false
					} );
				}
			} );
		}, 40 );

		editor.conversion.for( 'editingDowncast' ).markerToElement( {
			model: 'drop-target:position',
			view: ( data, { writer } ) => {
				// Check in schema to place UIElement only in place where text is allowed.
				if ( !editor.model.schema.checkChild( data.markerRange.start, '$text' ) ) {
					return;
				}

				return writer.createUIElement( 'span', { class: 'ck-drop-target__position' }, function( domDocument ) {
					const domElement = this.toDomElement( domDocument );

					domElement.innerHTML = '&#8203;<span class="ck-drop-target__line"></span>';

					return domElement;
				} );
			}
		} );

		editor.conversion.for( 'editingDowncast' ).markerToHighlight( {
			model: 'drop-target:range',
			view: {
				classes: [ 'ck-drop-target__range' ]
			}
		} );

		// Add 'draggable' attribute to the widget while pressing the selection handle.
		this.listenTo( viewDocument, 'mousedown', ( evt, data ) => {
			if ( data.target.hasClass( 'ck-widget__selection-handle' ) ) {
				const widget = data.target.findAncestor( isWidget );

				this._draggableElement = widget;
			}

			// Set attribute 'draggable' on editable to allow immediate dragging of the selected text range.
			else if ( env.isBlink && !viewDocument.selection.isCollapsed && !editor.model.document.selection.getSelectedElement() ) {
				this._draggableElement = viewDocument.selection.editableElement;
			}

			// Check if there is a widget to drag if mouse down wasn't directly on the editable element.
			else if ( !data.target.is( 'editableElement' ) ) {
				// Find closest ancestor that is either a widget or an editable element...
				const ancestor = data.target.findAncestor( node => isWidget( node ) || node.is( 'editableElement' ) );

				// ...and if closer was the widget then enable dragging it.
				if ( isWidget( ancestor ) ) {
					this._draggableElement = ancestor;
				}
			}

			if ( this._draggableElement ) {
				view.change( writer => writer.setAttribute( 'draggable', 'true', this._draggableElement ) );
			}
		} );

		this.listenTo( viewDocument, 'mouseup', () => {
			this._clearDraggableAttributes();
		} );
	}

	/**
	 * Delete the dragged content from it's original range.
	 *
	 * @private
	 * @param {Boolean} moved Whether the move succeeded.
	 */
	_finalizeDragging( moved ) {
		const editor = this.editor;
		const model = editor.model;

		this._removeDraggingMarkers();
		this._clearDraggableAttributes();

		if ( !this._draggedRange ) {
			return;
		}

		// Delete moved content.
		if ( moved ) {
			model.deleteContent( model.createSelection( this._draggedRange ), { doNotAutoparagraph: true } );
		}

		this._draggedRange.detach();
		this._draggedRange = null;
	}

	/**
	 * TODO
	 *
	 * @private
	 */
	_clearDraggableAttributes() {
		if ( !this._draggableElement ) {
			return;
		}

		// Remove 'draggable' attribute.
		this.editor.editing.view.change( writer => writer.removeAttribute( 'draggable', this._draggableElement ) );

		this._draggableElement = null;
	}

	/**
	 * Remove drop target markers.
	 *
	 * @private
	 */
	_removeDraggingMarkers() {
		const model = this.editor.model;

		this._updateMarkersThrottled.cancel();

		if ( model.markers.has( 'drop-target:position' ) ) {
			model.change( writer => {
				writer.removeMarker( 'drop-target:position' );
			} );
		}

		if ( model.markers.has( 'drop-target:range' ) ) {
			model.change( writer => {
				writer.removeMarker( 'drop-target:range' );
			} );
		}
	}
}

/**
 * Fired with a `content` and `dataTransfer` objects. The `content` which comes from the clipboard (was pasted or dropped)
 * should be processed in order to be inserted into the editor. The `dataTransfer` object is available
 * in case the transformation functions needs access to a raw clipboard data.
 *
 * It is a part of the {@glink framework/guides/deep-dive/clipboard#input-pipeline "clipboard input pipeline"}.
 *
 * @see module:clipboard/clipboardobserver~ClipboardObserver
 * @see module:clipboard/clipboard~Clipboard
 * @event module:clipboard/clipboard~Clipboard#event:inputTransformation
 * @param {Object} data Event data.
 * @param {module:engine/view/documentfragment~DocumentFragment} data.content Event data. Content to be inserted into the editor.
 * It can be modified by the event listeners. Read more about the clipboard pipelines in
 * {@glink framework/guides/deep-dive/clipboard "Clipboard" deep dive}.
 * @param {module:clipboard/datatransfer~DataTransfer} data.dataTransfer Data transfer instance.
 * @param {Boolean} data.asPlainText If set to `true` content is pasted as plain text.
 */

/**
 * Fired on {@link module:engine/view/document~Document#event:copy} and {@link module:engine/view/document~Document#event:cut}
 * with a copy of selected content. The content can be processed before it ends up in the clipboard.
 *
 * It is a part of the {@glink framework/guides/deep-dive/clipboard#output-pipeline "clipboard output pipeline"}.
 *
 * @see module:clipboard/clipboardobserver~ClipboardObserver
 * @see module:clipboard/clipboard~Clipboard
 * @event module:engine/view/document~Document#event:clipboardOutput
 * @param {module:clipboard/clipboard~ClipboardOutputEventData} data Event data.
 */

/**
 * The value of the {@link module:engine/view/document~Document#event:clipboardOutput} event.
 *
 * @class module:clipboard/clipboard~ClipboardOutputEventData
 */

/**
 * Data transfer instance.
 *
 * @readonly
 * @member {module:clipboard/datatransfer~DataTransfer} module:clipboard/clipboard~ClipboardOutputEventData#dataTransfer
 */

/**
 * Content to be put into the clipboard. It can be modified by the event listeners.
 * Read more about the clipboard pipelines in {@glink framework/guides/deep-dive/clipboard "Clipboard" deep dive}.
 *
 * @member {module:engine/view/documentfragment~DocumentFragment} module:clipboard/clipboard~ClipboardOutputEventData#content
 */

/**
 * Whether the event was triggered by copy or cut operation.
 *
 * @member {'copy'|'cut'} module:clipboard/clipboard~ClipboardOutputEventData#method
 */

// Returns true if specified `documentFragment` represents a plain text.
//
// @param {module:engine/view/documentfragment~DocumentFragment} documentFragment
// @param {module:engine/model/schema~Schema} schema
// @returns {Boolean}
function isPlainTextFragment( documentFragment, schema ) {
	if ( documentFragment.childCount > 1 ) {
		return false;
	}

	const child = documentFragment.getChild( 0 );

	if ( schema.isObject( child ) ) {
		return false;
	}

	return [ ...child.getAttributeKeys() ].length == 0;
}

// Returns fixed selection range for given position.
//
// @param {module:engine/model/model~Model} model
// @param TODO
// @returns {module:engine/model/range~Range}
function findDropTargetRange( editor, targetViewRanges, targetViewElement ) {
	const model = editor.model;
	const mapper = editor.editing.mapper;
	const view = editor.editing.view;

	const targetViewPosition = targetViewRanges ? targetViewRanges[ 0 ].start : null;
	const targetModelPosition = targetViewPosition ? mapper.toModelPosition( targetViewPosition ) : null;

	let targetModelElement = mapper.toModelElement( targetViewElement );

	// Find mapped ancestor if the target is inside the UIElement or any not mapped element.
	if ( !targetModelElement ) {
		targetModelElement = mapper.toModelElement( mapper.findMappedViewAncestor( view.createPositionBefore( targetViewElement ) ) );
	}

	// console.log( 'element:', targetModelElement.name, '-', 'path:', targetModelPosition ? `[${ targetModelPosition.path }]` : 'n/a' );

	// In Safari target position can be empty while hovering over a widget (for example page-break).
	// In all browsers there is no target position while hovering over an empty table cell.
	if ( !targetModelPosition ) {
		// Try searching for selectable position inside the element (for example empty table cell).
		const newRange = model.schema.getNearestSelectionRange( model.createPositionAt( targetModelElement, 0 ), 'forward' );

		// Find closest ancestor that is an object and return range on it if no valid selection range is found inside the element.
		return newRange ? newRange : findObjectAncestorRange( model, targetModelElement );
	}

	// There is a model position so try to fix it.
	else {
		// Try fixing selection position. In FF the target position is before widgets but in other browsers it tend to land after a widget.
		const newRange = model.schema.getNearestSelectionRange( targetModelPosition, env.isGecko ? 'forward' : 'backward' );

		// There is no valid position inside the current limit element so find closest object ancestor.
		return newRange ? newRange : findObjectAncestorRange( model, targetModelPosition.parent );
	}
}

// TODO
function findObjectAncestorRange( model, element ) {
	while ( element ) {
		if ( model.schema.isObject( element ) ) {
			return model.createRangeOn( element );
		}

		element = element.parent;
	}

	return null;
}
