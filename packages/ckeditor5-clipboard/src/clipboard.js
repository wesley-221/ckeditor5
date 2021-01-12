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

import HtmlDataProcessor from '@ckeditor/ckeditor5-engine/src/dataprocessor/htmldataprocessor';
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
		const viewDocument = view.document;

		/**
		 * Data processor used to convert pasted HTML to a view structure.
		 *
		 * @readonly
		 * @member {module:engine/dataprocessor/htmldataprocessor~HtmlDataProcessor} #htmlDataProcessor
		 */
		this.htmlDataProcessor = new HtmlDataProcessor( viewDocument );

		/**
		 * The range that was selected while dragging started.
		 *
		 * @type {module:engine/model/liverange~LiveRange}
		 * @private
		 */
		this._draggedRange = null;

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
				const targetPosition = editor.editing.mapper.toModelPosition( data.targetRanges[ 0 ].start );
				const targetRange = findDropTargetRange( editor.model, targetPosition );

				if ( targetRange ) {
					editor.model.change( writer => {
						writer.setSelection( targetRange );
					} );
				}

				// Don't do anything if some content was dragged within the same document to the same position.
				if ( this._draggedRange && this._draggedRange.containsRange( selection.getFirstRange(), true ) ) {
					dataTransfer.dropEffect = 'none';
					this._finalizeDragging( false );

					return;
				}
			}

			content = this.htmlDataProcessor.toView( content );

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
					this._finalizeDragging( true );

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
				data.dataTransfer.setData( 'text/html', this.htmlDataProcessor.toData( data.content ) );
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

			if ( selection.isCollapsed ) {
				data.preventDefault();

				return;
			}

			if ( data.domTarget.nodeType == 1 && domConverter.mapDomToView( data.domTarget ).is( 'rootElement' ) ) {
				data.preventDefault();

				return;
			}

			data.dataTransfer.effectAllowed = 'move';
			data.dataTransfer.dropEffect = 'move';

			const content = editor.data.toView( editor.model.getSelectedContent( modelDocument.selection ) );

			this._draggedRange = LiveRange.fromRange( modelDocument.selection.getFirstRange() );

			viewDocument.fire( 'clipboardOutput', { dataTransfer: data.dataTransfer, content, method: evt.name } );
		}, { priority: 'low' } );

		this.listenTo( viewDocument, 'dragend', ( evt, data ) => {
			this._finalizeDragging( !data.dataTransfer.isCanceled );
		}, { priority: 'low' } );

		this.listenTo( viewDocument, 'dragging', ( evt, data ) => {
			const mapper = editor.editing.mapper;

			if ( editor.isReadOnly ) {
				data.dataTransfer.dropEffect = 'none';

				return;
			}

			const targetPosition = mapper.toModelPosition( data.targetRanges[ 0 ].start );
			const targetRange = findDropTargetRange( editor.model, targetPosition );

			data.dataTransfer.dropEffect = targetRange ? 'move' : 'none';

			if ( targetRange ) {
				this._updateMarkersThrottled( targetRange );
			}
		}, { priority: 'low' } );

		this._updateMarkersThrottled = throttle( targetRange => {
			const editor = this.editor;

			editor.model.change( writer => {
				const markerName = `drop-target:${ targetRange.isCollapsed ? 'position' : 'range' }`;
				const otherMarkerName = `drop-target:${ !targetRange.isCollapsed ? 'position' : 'range' }`;

				if ( editor.model.markers.has( markerName ) ) {
					writer.updateMarker( markerName, { range: targetRange } );
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

		// Enable dragging text nodes.
		if ( !env.isSafari ) {
			view.change( writer => {
				for ( const viewRoot of viewDocument.roots ) {
					writer.setAttribute( 'draggable', 'true', viewRoot );
				}
			} );

			this.listenTo( viewDocument.roots, 'add', viewRoot => {
				view.change( writer => {
					writer.setAttribute( 'draggable', 'true', viewRoot );
				} );
			} );
		}

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
			if ( !data.target.hasClass( 'ck-widget__selection-handle' ) ) {
				return;
			}

			const widget = data.target.findAncestor( isWidget );

			view.change( writer => writer.setAttribute( 'draggable', 'true', widget ) );
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
		const editing = editor.editing;

		this._removeDraggingMarkers();

		if ( !this._draggedRange ) {
			return;
		}

		if ( moved ) {
			model.deleteContent( model.createSelection( this._draggedRange ), { doNotAutoparagraph: true } );
		} else {
			const modelElement = this._draggedRange.getContainedElement();
			const viewElement = modelElement ? editing.mapper.toViewElement( modelElement ) : null;

			if ( viewElement && isWidget( viewElement ) ) {
				editing.view.change( writer => writer.removeAttribute( 'draggable', viewElement ) );
			}
		}

		this._draggedRange.detach();
		this._draggedRange = null;
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
// @param {module:engine/model/position~Position} position
// @returns {module:engine/model/range~Range}
function findDropTargetRange( model, position ) {
	// The position will be just after a widget if the mouse cursor was just before a widget.
	const newRange = model.schema.getNearestSelectionRange( position, 'backward' );

	if ( newRange ) {
		return newRange;
	}

	// There is no valid position inside the current limit element so find closest object ancestor.
	let element = position.parent;

	while ( element ) {
		if ( model.schema.isObject( element ) ) {
			return model.createRangeOn( element );
		}

		element = element.parent;
	}

	return null;
}
