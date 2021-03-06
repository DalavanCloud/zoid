/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { once, memoize, noop, promisify } from 'belter/src';
import { isWindow, type CrossDomainWindowType } from 'cross-domain-utils/src';
import { ProxyWindow } from 'post-robot/src/serialize/window';

import { type DimensionsType } from '../../types';
import { PROP_SERIALIZATION } from '../../constants';

import type { Component } from './index';

type PropDefinitionType<T, P, S : string> = {|
    type : S,
    alias? : string,
    value? : () => ?T,
    required? : boolean,
    queryParam? : boolean | string | (T) => (string | ZalgoPromise<string>),
    queryValue? : (T) => (ZalgoPromise<mixed> | mixed),
    sendToChild? : boolean,
    allowDelegate? : boolean,
    validate? : (T, PropsType & P) => void,
    decorate? : (T, PropsType & P) => (T | void),
    def? : (P, Component<P>) => ? T,
    sameDomain? : boolean,
    serialization? : $Values<typeof PROP_SERIALIZATION>,
    childDecorate? : (T) => ?T
|};

export type BooleanPropDefinitionType<T : boolean, P> = PropDefinitionType<T, P, 'boolean'>;
export type StringPropDefinitionType<T : string, P> = PropDefinitionType<T, P, 'string'>;
export type NumberPropDefinitionType<T : number, P> = PropDefinitionType<T, P, 'number'>;
export type FunctionPropDefinitionType<T : Function, P> = PropDefinitionType<T, P, 'function'>;
export type ArrayPropDefinitionType<T : Array<*>, P> = PropDefinitionType<T, P, 'array'>;
export type ObjectPropDefinitionType<T : Object, P> = PropDefinitionType<T, P, 'object'>;

export type MixedPropDefinitionType<P> = BooleanPropDefinitionType<*, P> | StringPropDefinitionType<*, P> | NumberPropDefinitionType<*, P> | FunctionPropDefinitionType<*, P> | ObjectPropDefinitionType<*, P> | ArrayPropDefinitionType<*, P>;

export type UserPropsDefinitionType<P> = {
    [string] : MixedPropDefinitionType<P>
};

export type EventHandlerType<T> = (T) => void | ZalgoPromise<void>;

type envPropType = string;
type timeoutPropType = number;
type dimensionsPropType = DimensionsType;
type windowPropType = ProxyWindow;

type onDisplayPropType = EventHandlerType<void>;
type onEnterPropType = EventHandlerType<void>;
type onRenderPropType = EventHandlerType<void>;
type onClosePropType = EventHandlerType<string>;
type onErrorPropType = EventHandlerType<mixed>;

export type BuiltInPropsType = {
    env : envPropType,
    timeout? : timeoutPropType,
    dimensions? : dimensionsPropType,
    window? : windowPropType,

    onDisplay : onDisplayPropType,
    onEnter : onEnterPropType,
    onRender : onRenderPropType,
    onClose : onClosePropType,
    onError? : onErrorPropType
};

export type PropsType = {
    env? : envPropType,
    timeout? : timeoutPropType,
    dimensions? : dimensionsPropType,
    window? : windowPropType,

    onDisplay? : onDisplayPropType,
    onEnter? : onEnterPropType,
    onRender? : onRenderPropType,
    onClose? : onClosePropType,
    onError? : onErrorPropType
};

export type BuiltInPropsDefinitionType<P> = {
    env : StringPropDefinitionType<envPropType, P>,
    timeout : NumberPropDefinitionType<timeoutPropType, P>,
    dimensions : ObjectPropDefinitionType<dimensionsPropType, P>,
    window : ObjectPropDefinitionType<windowPropType, P>,

    onDisplay : FunctionPropDefinitionType<onDisplayPropType, P>,
    onEnter : FunctionPropDefinitionType<onEnterPropType, P>,
    onRender : FunctionPropDefinitionType<onRenderPropType, P>,
    onClose : FunctionPropDefinitionType<onClosePropType, P>,
    onError : FunctionPropDefinitionType<onErrorPropType, P>
};

/*  Internal Props
    --------------

    We define and use certain props by default, for configuration and events that are used at the framework level.
    These follow the same format as regular props, and are classed as reserved words that may not be overriden by users.
*/

export function getInternalProps<P>() : BuiltInPropsDefinitionType<P> {
    return {

        // The desired env in which the component is being rendered. Used to determine the correct url

        env: {
            type:       'string',
            queryParam: true,
            required:   false,
            def(props, component) : ?string {
                return component.defaultEnv;
            }
        },

        window: {
            type:        'object',
            sendToChild: false,
            required:    false,
            validate(val : CrossDomainWindowType | ProxyWindow) {
                if (!isWindow(val) && !ProxyWindow.isProxyWindow(val)) {
                    throw new Error(`Expected Window or ProxyWindow`);
                }
            },
            decorate(val : CrossDomainWindowType | ProxyWindow | void) : ProxyWindow | void {
                if (val) {
                    return ProxyWindow.toProxyWindow(val);
                }
            }
        },

        dimensions: {
            type:     'object',
            required: false
        },

        timeout: {
            type:        'number',
            required:    false,
            sendToChild: false
        },

        onDisplay: {
            type:        'function',
            required:    false,
            sendToChild: false,

            def() : Function {
                return noop;
            },

            decorate(onDisplay : Function) : Function {
                return memoize(promisify(onDisplay));
            }
        },

        onEnter: {
            type:        'function',
            required:    false,
            sendToChild: false,

            def() : Function {
                return noop;
            },

            decorate(onEnter : Function) : Function {
                return promisify(onEnter);
            }
        },

        // When we get an INIT message from the child

        onRender: {
            type:        'function',
            required:    false,
            sendToChild: false,

            def() : Function {
                return noop;
            },

            decorate(onRender : Function) : Function {
                return promisify(onRender);
            }
        },

        // When the user closes the component.

        onClose: {
            type:        'function',
            required:    false,
            sendToChild: false,

            def() : Function {
                return noop;
            },

            decorate(onClose : Function) : Function {
                return once(promisify(onClose));
            }
        },

        // When the component experiences an error

        onError: {
            type:        'function',
            required:    false,
            sendToChild: true,
            def() : (() => void) {
                return function onError(err : mixed) {
                    setTimeout(() => {
                        throw err;
                    });
                };
            },

            decorate(onError : Function) : Function {
                return once(promisify(onError));
            }
        }
    };
}
