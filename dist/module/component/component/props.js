import { ZalgoPromise } from 'zalgo-promise/src';
import { uniqueID, once, memoize, noop, promisify } from 'belter/src';

import '../../types';
import { PROP_SERIALIZATION } from '../../constants';

/*  Internal Props
    --------------

    We define and use certain props by default, for configuration and events that are used at the framework level.
    These follow the same format as regular props, and are classed as reserved words that may not be overriden by users.
*/

export function getInternalProps() {
    return {

        // The desired env in which the component is being rendered. Used to determine the correct url

        env: {
            type: 'string',
            queryParam: true,
            required: false,
            def: function def(props, component) {
                return component.defaultEnv;
            }
        },

        uid: {
            type: 'string',
            def: function def() {
                return uniqueID();
            },

            queryParam: true
        },

        dimensions: {
            type: 'object',
            required: false
        },

        timeout: {
            type: 'number',
            required: false,
            sendToChild: false
        },

        onDisplay: {
            type: 'function',
            required: false,
            sendToChild: false,

            def: function def() {
                return noop;
            },
            decorate: function decorate(onDisplay) {
                return memoize(promisify(onDisplay));
            }
        },

        onEnter: {
            type: 'function',
            required: false,
            sendToChild: false,

            def: function def() {
                return noop;
            },
            decorate: function decorate(onEnter) {
                return promisify(onEnter);
            }
        },

        // When we get an INIT message from the child

        onRender: {
            type: 'function',
            required: false,
            sendToChild: false,

            def: function def() {
                return noop;
            },
            decorate: function decorate(onRender) {
                return promisify(onRender);
            }
        },

        // When the user closes the component.

        onClose: {
            type: 'function',
            required: false,
            sendToChild: false,

            def: function def() {
                return noop;
            },
            decorate: function decorate(onClose) {
                return once(promisify(onClose));
            }
        },

        // When the component experiences an error

        onError: {
            type: 'function',
            required: false,
            sendToChild: true,
            def: function def() {
                return function onError(err) {
                    setTimeout(function () {
                        throw err;
                    });
                };
            },
            decorate: function decorate(onError) {
                return once(promisify(onError));
            }
        }
    };
}