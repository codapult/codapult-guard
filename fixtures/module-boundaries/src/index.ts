import { value } from '@fixture/barrel';

export const required = require('./shared.js');
export const loaded = import('./shared.js');
export const result = `${value}:${required.value}`;
