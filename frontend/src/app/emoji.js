// A small, dependency-free emoji picker for page icons.
import { h } from '../lib/dom.js';
import { openPopover } from '../lib/popover.js';

const EMOJI = [
  '📄', '📝', '📒', '📓', '📔', '📕', '📗', '📘', '📙', '📚', '🗒️', '🗂️', '📁', '📂', '🗃️', '📌',
  '📎', '🔖', '🏷️', '✏️', '🖊️', '🖋️', '📅', '📆', '🗓️', '⏰', '⏳', '📊', '📈', '📉', '🧮', '💡',
  '🔍', '🔑', '🔒', '🔓', '🛠️', '🔧', '⚙️', '🧰', '🧪', '🔬', '🧬', '💻', '🖥️', '⌨️', '🖱️', '📱',
  '🌐', '☁️', '🗄️', '💾', '📡', '🚀', '✈️', '🧭', '🗺️', '🏠', '🏢', '🏗️', '🎯', '🏆', '🥇', '🎓',
  '💼', '💰', '💳', '🧾', '📦', '🛒', '🎁', '📣', '💬', '🗨️', '✉️', '📥', '📤', '📬', '🤝', '👥',
  '👤', '🧠', '❤️', '⭐', '🌟', '✨', '🔥', '⚡', '🌈', '☀️', '🌙', '🌱', '🌿', '🌳', '🍀', '🌸',
  '🍎', '🍋', '☕', '🍵', '🍕', '🎵', '🎨', '🎬', '📷', '🎮', '⚽', '🏃', '🧘', '🐛', '🐞', '🦊',
  '🐱', '🐶', '🦉', '🐝', '✅', '☑️', '❌', '⚠️', '⛔', '❓', '❗', '♻️', '🔔', '🧩', '🪄', '🧱',
];

export function openEmojiPicker({ anchor, current, onPick }) {
  const custom = h('input', {
    class: 'input',
    placeholder: 'Or type any emoji…',
    maxLength: 8,
    'aria-label': 'Custom emoji',
  });
  const pick = (value) => {
    popover.close();
    onPick(value);
  };
  const content = h(
    'div',
    { class: 'emoji-picker' },
    h(
      'form',
      {
        class: 'emoji-top',
        onsubmit: (event) => {
          event.preventDefault();
          const value = custom.value.trim();
          if (value) pick(value);
        },
      },
      custom,
      current
        ? h(
            'button',
            { class: 'button button-small', type: 'button', onclick: () => pick(null) },
            'Remove',
          )
        : null,
    ),
    h(
      'div',
      { class: 'emoji-grid' },
      EMOJI.map((emoji) =>
        h('button', { type: 'button', 'aria-label': emoji, onclick: () => pick(emoji) }, emoji),
      ),
    ),
  );
  const popover = openPopover({ anchor, content, placement: 'bottom-start' });
  return popover;
}
