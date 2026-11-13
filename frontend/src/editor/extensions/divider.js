import { nodeInputRule } from '@tiptap/core';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';

// Same node as Tiptap's horizontal rule, but the Markdown shortcut waits for
// the space ("---" + Space) so that typing dashes never surprises anyone.
export const Divider = HorizontalRule.extend({
  addInputRules() {
    return [
      nodeInputRule({
        find: /^(?:---|—-|___|\*\*\*)\s$/,
        type: this.type,
      }),
    ];
  },
});
