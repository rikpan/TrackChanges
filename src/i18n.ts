/**
 * Messages the extension shows at runtime, in English and Simplified Chinese.
 *
 * The language comes from the `trackChanges.language` setting; "auto" follows
 * the VS Code display language. Command names and setting descriptions are
 * localized separately by VS Code from package.nls*.json and always follow
 * the display language.
 */

export type Language = 'en' | 'zh-cn';

const messages = {
    enabled: { en: 'Track Changes enabled', 'zh-cn': '跟踪更改已开启' },
    disabled: { en: 'Track Changes disabled', 'zh-cn': '跟踪更改已关闭' },
    noChanges: { en: 'Track Changes: no changes in this file', 'zh-cn': '跟踪更改：此文件没有修改' },
} satisfies Record<string, Record<Language, string>>;

export type MessageKey = keyof typeof messages;

/** Resolve the `trackChanges.language` setting against the VS Code display language. */
export function resolveLanguage(setting: string | undefined, displayLanguage: string): Language {
    if (setting === 'en' || setting === 'zh-cn') {
        return setting;
    }
    return displayLanguage.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

export function message(key: MessageKey, language: Language): string {
    return messages[key][language];
}
