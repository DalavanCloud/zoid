import 'zalgo-promise/src';
// eslint-disable-next-line import/no-namespace
import * as _postRobot from 'post-robot/src';

import { Component } from './component';
import { ParentComponent } from './component/parent';
// eslint-disable-next-line import/no-namespace
import * as _CONSTANTS from './constants';

export { PopupOpenError } from 'belter/src';

export function create(options) {
    return new Component(options);
}

export function getByTag(tag) {
    return Component.getByTag(tag);
}

export { getCurrentScriptDir, useLogger } from './lib';

export function destroyAll() {
    return ParentComponent.destroyAll();
}
export var postRobot = _postRobot;

export var CONSTANTS = _CONSTANTS;