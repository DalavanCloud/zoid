
import postRobot from 'post-robot/src';
import { SyncPromise as Promise } from 'sync-browser-mocks/src/promise';
import { BaseComponent } from './base';
import { urlEncode, popup, noop, extend, getElement, getParentWindow, once, iframe, onCloseWindow, getParentNode, denodeify, memoize, createElement, createStyleSheet, uniqueID } from '../lib';
import { CONSTANTS, CONTEXT_TYPES, MAX_Z_INDEX } from '../constants';
import { PopupOpenError } from '../error';

let activeComponents = [];

/*  Render Drivers
    --------------

    There are various differences in how we treat:

    - Opening frames and windows
    - Rendering up to the parent
    - Showing overlays

    based on the context we're rendering to.

    These render drivers split this functionality out in a driver pattern, so our component code doesn't bunch up into a
    series of if-popup-then-else-if-lightbox code.
*/

let RENDER_DRIVERS = {

    // Iframe context is rendered inline on the page, without any kind of overlay. It's the one context that is designed
    // to feel like a native element on the page.

    [ CONTEXT_TYPES.IFRAME ]: {

        overlay: false,

        open(element) {

            this.iframe = iframe(element, null, {
                name: this.childWindowName,
                width: this.component.dimensions.width,
                height: this.component.dimensions.height
            });

            this.registerForCleanup(() => {
                if (this.iframe) {
                    this.iframe.parentNode.removeChild(this.iframe);
                    delete this.iframe;
                }
            });

            this.setForCleanup('context', CONSTANTS.CONTEXT.IFRAME);
            this.setForCleanup('window', this.iframe.contentWindow);

            // There's a possibility that our iframe's dom element could be removed by other code, for a variety of
            // reasons. As such, we need to periodically check we still have a child window that is open.

            this.watchForClose();

            return this;
        },

        renderToParent(element) {

            // No special behavior needed to renderToParent
        }
    },

    // Popup context opens up a centered lightbox-like popup window on the page, with an overlay behind it.

    [ CONTEXT_TYPES.POPUP ]: {

        overlay: true,

        open() {

            let pos = this.getPosition();

            this.popup = popup('about:blank', {
                name: this.childWindowName,
                width: this.component.dimensions.width,
                height: this.component.dimensions.height,
                top: pos.y,
                left: pos.x
            });

            this.registerForCleanup(() => {
                if (this.popup) {
                    this.popup.close();
                    delete this.popup;
                }
            });

            // Sometimes we'll be blocked from opening the popup because we're not in a click event.

            if (!this.popup || this.popup.closed || typeof this.popup.closed === 'undefined') {
                throw new PopupOpenError(`[${this.component.tag}] Can not open popup window - blocked`);
            }

            this.setForCleanup('context', CONSTANTS.CONTEXT.POPUP);
            this.setForCleanup('window', this.popup);

            // With popups, since they can be closed manually by the user with no feedback to us, we need to watch for
            // them being closed.

            this.watchForClose();

            return this;
        },

        renderToParent() {

            // Popups are the only case where we need to do anything special to render to parent.
            // Because we need a click event, we have to open up the popup from the child the moment it's requested,
            // Then message up and continue the rendering process from the parent as with any other renderToParent.

            // We need to calculate the child window name again so we can inform it that it's a renderToParent proxy case.

            this.childWindowName = this.buildChildWindowName(window.name, { proxy: true });

            // And then we need to open the popup immediately

            this.open(null, CONTEXT_TYPES.POPUP);
        }
    },

    // Lightbox context opens up a centered, iframe based lightbox on the page, with an overlay behind it.

    [ CONTEXT_TYPES.LIGHTBOX ]: {

        overlay: true,

        open() {

            this.open(document.body, CONTEXT_TYPES.IFRAME);

            let pos = this.getPosition();

            // TODO: some of this should be done in the parent.css file

            this.iframe.style.zIndex = MAX_Z_INDEX;
            this.iframe.style.position = 'absolute';
            this.iframe.style.left = pos.x;
            this.iframe.style.top = pos.y;
            this.iframe.style.borderRadius = '10px';

            return this;
        },

        renderToParent() {

            // No special behavior needed to renderToParent
        }
    }
};



/*  Parent Component
    ----------------

    This manages the state of the component on the parent window side - i.e. the window the component is being rendered into.

    It handles opening the necessary windows/iframes, launching the component's url, and listening for messages back from the component.
*/

export class ParentComponent extends BaseComponent {

    constructor(component, options = {}) {
        super(component, options);
        this.component = component;

        this.id = uniqueID();


        // Ensure the component is not loaded twice on the same page, if it is a singleton

        if (component.singleton && activeComponents.some(comp => comp.component === component)) {
            throw new Error(`${component.tag} is a singleton, and an only be instantiated once`);
        }

        activeComponents.push(this);

        this.validate(options);
        this.parentWindow = getParentWindow();

        this.setProps(options.props || {});


        // Options passed during renderToParent. We would not ordinarily expect a user to pass these, since we depend on
        // them only when we're trying to render from a sibling to a sibling

        this.childWindowName = options.childWindowName || this.buildChildWindowName(window.name);

        this.screenWidth = options.screenWidth || window.outerWidth;
        this.screenHeight = options.screenHeight || window.outerHeight;


        // Add parent.css to the parent page

        this.createParentStyle();

        // Set up promise for init

        this.onInit = new Promise();
    }


    /*  Set Props
        ---------

        Normalize props and generate the url we'll use to render the component
    */

    setProps(props) {
        this.props = this.normalizeProps(props);
        this.url   = this.buildUrl();
    }


    /*  Build Url
        ---------

        We build the props we're passed into the initial url. This means the component server-side can start rendering
        itself based on whatever props the merchant provides.
    */

    buildUrl() {

        let url;

        if (this.props.url) {
            url = this.props.url;
        } else if (this.props.env) {
            url = this.component.envUrls[this.props.env];
        } else {
            url = this.component.url;
        }

        let queryString = this.propsToQuery(this.props);

        if (queryString) {
            url = `${ url }${ url.indexOf('?') === -1 ? '?' : '&' }${ queryString }`;
        }

        return url;
    }


    /*  Update Props
        ------------

        Send new props down to the child
    */

    updateProps(props) {

        // Wait for init to complete successfully

        return this.onInit.then(() => {

            let oldProps = JSON.stringify(this.props);

            let newProps = {};
            extend(newProps, this.props);
            extend(newProps, props);

            this.setProps(newProps);

            // Only send down the new props if they do not match the old

            if (this.window && oldProps !== JSON.stringify(this.props)) {
                return postRobot.send(this.window, CONSTANTS.POST_MESSAGE.PROPS, {
                    props: this.props
                });
            }
        });
    }


    /*  Validate
        --------

        Validate options passed to
    */

    validate(options) {

        // TODO: Implement this
    }


    /*  Normalize Props
        ---------------

        Turn props into normalized values, using defaults, function options, etc.
    */

    normalizeProps(props) {
        this.validateProps(props);

        props = props || {};
        let result = {};

        for (let key of Object.keys(this.component.props)) {

            let prop = this.component.props[key];
            let value = props[key];

            let hasProp = props.hasOwnProperty(key) && value !== null && value !== undefined && value !== '';

            // Substitute in provided default. If prop.def is a function, we call it to get the default.

            if (!hasProp && prop.def) {
                value = (prop.def instanceof Function && prop.type !== 'function') ? prop.def() : prop.def;
            }

            // If we have a defaultProp, use the value of that prop for this one

            else if (!hasProp && prop.defaultProp) {
                value = props[prop.defaultProp];
            }

            if (prop.type === 'boolean') {
                result[key] = Boolean(value);

            } else if (prop.type === 'function') {

                if (!value) {

                    // If prop.noop is set, make the function a noop

                    if (!value && prop.noop) {
                        value = noop;
                    }

                } else {

                    // If prop.denodeify is set, denodeify the function (accepts callback -> returns promise)

                    if (prop.denodeify) {
                        value = denodeify(value);
                    }

                    // If prop.once is set, ensure the function can only be called once

                    if (prop.once) {
                        value = once(value);
                    }

                    // If prop.memoize is set, ensure the function is memoized (first return value is cached and returned for any future calls)

                    if (prop.memoize) {
                        value = memoize(value);
                    }
                }

                result[key] = value;

            } else if (prop.type === 'string') {
                result[key] = value || '';

            } else if (prop.type === 'object') {
                result[key] = JSON.stringify(value);

            } else if (prop.type === 'number') {
                result[key] = parseInt(value || 0, 10);
            }
        }

        return result;
    }



    /*  Props to Query
        --------------

        Turn props into an initial query string to open the component with

        string -> string
        bool   -> 1
        object -> json
        number -> string
    */

    propsToQuery(props) {

        return Object.keys(props).map(key => {

            let value = props[key];

            if (!value) {
                return '';
            }

            let result;

            if (typeof value === 'boolean') {
                result = '1';
            } else if (typeof value === 'string') {
                result = value.toString();
            } else if (typeof value === 'function') {
                return;
            } else if (typeof value === 'object') {
                result = JSON.stringify(value);
            } else if (typeof value === 'number') {
                result = value.toString();
            }

            return `${urlEncode(key)}=${urlEncode(result)}`;

        }).filter(Boolean).join('&');
    }


    /*  Get Position
        ------------

        Calculate the position for the popup / lightbox

        This is either
        - Specified by the user
        - The center of the screen

        I'd love to do this with pure css, but alas... popup windows :(
    */

    getPosition() {

        let pos = {};
        let dimensions = this.component.dimensions;

        if (typeof dimensions.x === 'number') {
            pos.x = dimensions.x;
        } else {
            let width = this.screenWidth;

            if (width <= dimensions.width) {
                pos.x = 0;
            } else {
                pos.x = Math.floor((width / 2) - (dimensions.width / 2));
            }
        }

        if (typeof dimensions.y === 'number') {
            pos.y = dimensions.y;
        } else {

            let height = this.screenHeight;

            if (height <= dimensions.height) {
                pos.y = 0;
            } else {
                pos.y = Math.floor((height / 2) - (dimensions.height / 2));
            }
        }

        return pos;
    }


    /*  Get Render Context
        ------------------

        Determine the ideal context to render to, if unspecified by the user
    */

    getRenderContext(el) {

        if (el) {

            if (!this.component.contexts[CONTEXT_TYPES.IFRAME]) {
                throw new Error(`[${this.component.tag}] Iframe context not allowed`);
            }

            return CONTEXT_TYPES.IFRAME;
        }

        if (this.component.defaultContext) {

            if (this.component.defaultContext === CONTEXT_TYPES.LIGHTBOX) {
                return CONTEXT_TYPES.LIGHTBOX;
            }

            if (this.component.defaultContext === CONTEXT_TYPES.POPUP) {
                return CONTEXT_TYPES.POPUP;
            }
        }

        if (this.component.contexts[CONTEXT_TYPES.LIGHTBOX]) {
            return CONTEXT_TYPES.LIGHTBOX;

        }

        if (this.component.contexts[CONTEXT_TYPES.POPUP]) {
            return CONTEXT_TYPES.POPUP;
        }

        throw new Error(`[${this.component.tag}] No context options available for render`);
    }


    /*  Render
        ------

        Kick off the actual rendering of the component:

        - open the popup/iframe
        - load the url into it
        - set up listeners
    */

    render(element, context) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Can not render: component is already rendered`);
        }

        if (context && !this.component.contexts[context]) {
            throw new Error(`Invalid context: ${context}`);
        }

        context = context || this.getRenderContext(element);

        this.open(element, context);
        this.listen(this.window);
        this.loadUrl(this.url);
        this.runTimeout();

        if (RENDER_DRIVERS[context].overlay) {
            this.createOverlayTemplate();
        }
    }


    /*  Open
        ----

        Open a new window in the desired context
    */

    open(element, context) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Can not open: component is already rendered`);
        }

        RENDER_DRIVERS[context].open.call(this, element);

        this.createComponentTemplate();
    }


    /*  Render to Parent
        ----------------

        Instruct the parent window to render our component for us -- so, for example, we can have a button component
        which opens a lightbox on the parent page, with a full overlay. Or, we could use this to render an iframe based
        modal on top of our existing iframe component, without having to expand out the size of our current iframe.
    */

    renderToParent(element, context, options = {}) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        if (context && !this.component.contexts[context]) {
            throw new Error(`Invalid context: ${context}`);
        }

        context = context || this.getRenderContext(element);

        if (!this.parentWindow) {
            throw new Error(`[${this.component.tag}] Can not render to parent - no parent exists`);
        }

        if (!window.name) {
            throw new Error(`[${this.component.tag}] Can not render to parent - not in a child component window`);
        }

        // Do any specific stuff needed for particular contexts. For example -- for popups, we have no choice but to
        // open them from the child, since we depend on there being a click event to avoid the popup blocker.

        RENDER_DRIVERS[context].renderToParent.call(this, element);

        // Message the parent to instruct them on what to render and how. Since post-robot supports sending functions
        // across, we can pretty much just send all of our props over too without any problems

        return postRobot.sendToParent(CONSTANTS.POST_MESSAGE.RENDER, {

            // <3 ES6
            ...options,

            tag: this.component.tag,
            context: context,
            element: element,

            options: {
                props: this.props,

                childWindowName: this.childWindowName,
                screenWidth:     this.screenWidth,
                screenHeight:    this.screenHeight
            }

        }).then(data => {

            // Luckily we're allowed to access any frames created by our parent window, so we can get a handle on the child component window.

            if (!this.window) {
                this.setForCleanup('window', this.parentWindow.frames[this.childWindowName]);
            }

            // We don't want to proxy all of our messages through the parent window. Instead we'll just listen directly for
            // messages on the sibling window, since we have a handle on it.

            this.listen(this.window);
        });
    }


    /*  Render Iframe
        -------------

        Render the component to an iframe
    */

    renderIframe(element) {

        if (!element) {
            throw new Error(`[${this.component.tag}] Must specify element to render iframe`);
        }

        return this.render(element, CONTEXT_TYPES.IFRAME);
    }


    /*  Render Iframe to Parent
        -----------------------

        Render the component to an iframe in the parent window
    */

    renderIframeToParent(element) {

        if (!element) {
            throw new Error(`[${this.component.tag}] Must specify element to render iframe to parent`);
        }

        return this.renderToParent(element, CONTEXT_TYPES.IFRAME);
    }


    /*  Render Lightbox
        ---------------

        Render the component to a lightbox
    */

    renderLightbox() {
        return this.render(null, CONTEXT_TYPES.LIGHTBOX);
    }


    /*  Render Lightbox to Parent
        -------------------------

        Render the component to a lightbox in the parent window
    */

    renderLightboxToParent() {
        return this.renderToParent(null, CONTEXT_TYPES.LIGHTBOX);
    }


    /*  Render Popup
        ------------

        Render the component to a popup
    */

    renderPopup() {
        return this.render(null, CONTEXT_TYPES.POPUP);
    }


    /*  Render Popup to Parent
        ----------------------

        Render the component to a popup in the parent window
    */

    renderPopupToParent() {
        return this.renderToParent(null, CONTEXT_TYPES.POPUP);
    }


    /*  Watch For Close
        ---------------

        Watch for the child window closing, so we can cleanup.
        Also watch for this window changing location, so we can close the component.
    */

    watchForClose() {

        onCloseWindow(this.window, () => {
            this.props.onClose(new Error(`[${this.component.tag}] ${this.context} was closed`));
            this.destroy();
        });

        // Our child has know way of knowing if we navigated off the page. So we have to listen for beforeunload
        // and close the child manually if that happens.

        window.addEventListener('beforeunload', () => {
            if (this.popup) {
                this.popup.close();
            }
        });
    }


    /*  Load Url
        --------

        Load url into the child window. This is separated out because it's quite common for us to have situations
        where opening the child window and loading the url happen at different points.
    */

    loadUrl(url) {

        if (this.popup) {
            this.popup.location = url;
        } else if (this.iframe) {
            this.iframe.src = url;
        }
    }


    /*  Hijack Button
        -------------

        In this case, we don't actually know the final url for the component. The parent page might have a link or a form
        which points directly to our component url, or indirectly via a 302.

        So here, we listen for a click on the button or link, and hijack the target window. That way, we can be responsible
        for opening the window, listening for messages, etc. while the parent page is responsible only for generating the url
        to redirect to.

        This is necessary because in these cases, there's no way to accurately ascertain the url we're going to before
        we're redirected there -- so we let the parent redirect, but handle everything else involving the lifecycle of
        the component.

        This is a pretty esoteric case -- so if you need it, cool, otherwise you don't need to spend too much time
        worrying about it.
    */

    hijackButton(element, context = CONTEXT_TYPES.LIGHTBOX) {
        let el = getElement(element);

        if (!el) {
            throw new Error(`[${this.component.tag}] Can not find element: ${element}`);
        }

        let isButton = el.tagName.toLowerCase() === 'button' || (el.tagName.toLowerCase() === 'input' && el.type === 'submit');

        // For links, we can set the target directly on the link. But for form buttons, we need to set the target on the form itself.

        if (isButton) {
            el = getParentNode(el, 'form');
        }

        // We need to wait for the click event, which is necessary for opening a popup (if we need to)

        el.addEventListener('click', event => {

            if (this.window) {
                event.preventDefault();
            }

            // Point the element to open in our child window

            el.target = this.childWindowName;

            this.renderHijack(context);
        });

        return this;
    }


    /*  Render Hijack
        -------------

        Do a normal render, with the exception that we don't load the url into the child since our hijacked link or button will do that for us
    */

    renderHijack(context = CONTEXT_TYPES.LIGHTBOX) {

        if (this.window) {
            throw new Error(`[${this.component.tag}] Component is already rendered`);
        }

        // Immediately open the window, but don't try to set the url -- this will be done by the browser using the form action or link href

        this.open(null, context);

        // Do everything else the same way -- listen for events, render the overlay, etc.

        this.listen(this.window);
        this.runTimeout();

        if (RENDER_DRIVERS[context].overlay) {
            this.createOverlayTemplate();
        }
    }


    /*  Hijack Button to Popup
        ----------------------

        Hijack a link or button to render a popup
    */

    hijackButtonToPopup(element) {
        return this.hijackButton(element, CONTEXT_TYPES.POPUP);
    }


    /*  Hijack Button to Lightbox
        -------------------------

        Hijack a link or button to render a lightbox
    */

    hijackButtonToLightbox(element) {
        return this.hijackButton(element, CONTEXT_TYPES.LIGHTBOX);
    }


    /*  Hijack Submit Parent Form
        -------------------------

        This takes the 'hijack' case a little further, and allows hijacking to work even when the button is actually
        in a child component. So if the parent window has a form, and inside that form is a component, and inside that
        component is a button, this can be used to submit the parent form using the child button and hijack the resulting
        url into an xcomponent.

        This is, again, an esoteric case within an esoteric case -- so probably only consider using it if you're sure you want to.
    */

    hijackSubmitParentForm() {
        return this.renderToParent(null, CONTEXT_TYPES.POPUP, {
            hijackSubmitParentForm: true
        });
    }


    /*  Run Timeout
        -----------

        Set a timeout on the initial render, and call this.props.onTimeout if we don't get an init call in time.
    */

    runTimeout() {

        if (this.props.timeout) {
            setTimeout(() => {

                // If this.onInit has been previously resolved, this won't have any effect.

                this.onInit.reject().catch(function() {
                    let err = new Error(`[${this.component.tag}] Loading component ${this.component.tag} at ${this.url} timed out after ${this.props.timeout} milliseconds`);
                    this.props.onTimeout.call(this, err);
                    this.destroy();
                });

            }, this.props.timeout);
        }
    }


    /*  Listeners
        ---------

        Post-robot listeners to the child component window
    */

    listeners() {
        return {

            // The child rendered, and the component called .attach()
            // We have no way to know when the child has set up its listeners for the first time, so we have to listen
            // for this message to be sure so we can continue doing anything from the parent

            [ CONSTANTS.POST_MESSAGE.INIT ](source, data) {
                this.props.onEnter.call(this);
                this.onInit.resolve();

                // Let the child know what its context is, and what its initial props are.

                return {
                    context: this.context,
                    props: this.props
                };
            },


            // The child has requested that we close it. Since lightboxes and iframes can't close themselves, we need
            // this logic to exist in the parent window

            [ CONSTANTS.POST_MESSAGE.CLOSE ](source, data) {
                this.destroy();
            },


            // Iframes can't resize themselves, so they need the parent to take care of it for them.

            [ CONSTANTS.POST_MESSAGE.RESIZE ](source, data) {

                if (this.context === CONSTANTS.CONTEXT.POPUP) {
                    throw new Error(`[${this.component.tag}] Can not resize popup from parent`);
                }

                return this.resize(data.width, data.height);
            },


            // We got a request to render from the child (renderToParent)

            [ CONSTANTS.POST_MESSAGE.RENDER ](source, data) {

                let component = this.component.getByTag(data.tag);
                let instance  = component.parent(data.options);

                // In the case where we're submitting the parent form using hijackSubmitParentForm

                if (data.hijackSubmitParentForm) {

                    // Open the window and do everything except load the url

                    instance.renderHijack(data.context);

                    // Submit the form to load the url into the new window

                    getParentNode(this.iframe, 'form').submit();
                }

                // Otherwise we're just doing a normal render on behalf of the child

                else {
                    instance.render(data.element, data.context);
                }
            },


            // The child encountered an error

            [ CONSTANTS.POST_MESSAGE.ERROR ](source, data) {
                this.destroy();
                this.props.onError(new Error(data.error));
            }
        };
    }


    /*  Close
        -----

        Close the child component
    */

    close() {
        return postRobot.send(this.window, CONSTANTS.POST_MESSAGE.CLOSE).catch(err => {
            console.warn('Error sending close message to child', err.stack || err.toString());
            this.destroy();
        });
    }


    /*  Focus
        -----

        Focus the child component window
    */

    focus() {
        if (this.popup) {
            this.popup.focus();
        }
        return this;
    }


    /*  Resize
        ------

        Resize the child component window
    */

    resize(height, width) {
        return Promise.resolve().then(() => {

            if (this.context === CONSTANTS.CONTEXT.POPUP) {
                return postRobot.send(this.popup, CONSTANTS.POST_MESSAGE.RESIZE, {
                    height,
                    width
                });

            } else if (this.context === CONSTANTS.CONTEXT.IFRAME) {

                this.iframe.height = height;
                this.iframe.width = width;
            }
        });
    }


    /*  Create Parent Style
        -------------------

        Creates a stylesheet on the parent page, to control how the child component is rendered
    */

    createParentStyle() {
        this.overlayStyle = createStyleSheet(this.component.parentStyle, document.body);
    }


    /*  Create Component Template
        -------------------------

        Creates an initial template and stylesheet which are loaded into the child window, to be displayed before the url is loaded
    */

    createComponentTemplate() {

        createElement('body', {

            html: this.component.componentTemplate,

            class: [
                `xcomponent-component`
            ]

        }, this.window.document.body);

        createStyleSheet(this.component.componentStyle, this.window.document.body);
    }


    /*  Create Overlay Template
        -----------------------

        Create a template and stylesheet for the overlay behind the popup/lightbox
    */

    createOverlayTemplate() {

        this.overlay = createElement('div', {

            html: this.component.overlayTemplate,

            class: [
                `xcomponent-overlay`,
                `xcomponent-${this.context}`
            ],

            style: {
                zIndex: MAX_Z_INDEX - 1
            }

        }, document.body);

        this.overlayStyle = createStyleSheet(this.component.overlayStyle, document.body);

        this.overlay.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.focus();
        });

        Array.prototype.slice.call(this.overlay.getElementsByClassName('xcomponent-close')).forEach(el => {
            el.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            });
        });

        this.registerForCleanup(() => {
            document.body.removeChild(this.overlay);
            document.body.removeChild(this.overlayStyle);
        });
    }


    /*  Destroy
        -------

        Close the component and clean up any listeners and state
    */

    destroy() {
        this.cleanup();
    }

}