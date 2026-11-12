import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { message, resolveLanguage } from '../src/i18n';

test('auto follows the VS Code display language', () => {
    assert.equal(resolveLanguage('auto', 'zh-cn'), 'zh-cn');
    assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh-cn');
    assert.equal(resolveLanguage('auto', 'en'), 'en');
    assert.equal(resolveLanguage('auto', 'ja'), 'en');
    assert.equal(resolveLanguage(undefined, 'zh-cn'), 'zh-cn');
});

test('an explicit choice overrides the display language', () => {
    assert.equal(resolveLanguage('en', 'zh-cn'), 'en');
    assert.equal(resolveLanguage('zh-cn', 'en'), 'zh-cn');
});

test('messages exist in both languages', () => {
    assert.equal(message('noChanges', 'en'), 'Track Changes: no changes in this file');
    assert.equal(message('noChanges', 'zh-cn'), '跟踪更改：此文件没有修改');
});
