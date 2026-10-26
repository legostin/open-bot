// Whether a chat view stays pinned to its newest message after a scroll event.

/** Within this many pixels of the bottom the view counts as at the bottom. */
export const STICK_DISTANCE = 120;

/**
 * Only the person scrolling up unpins the view. The scroll event of putting the view at the bottom can arrive after
 * more content rendered (cards, plugin widgets): it looks far from the bottom too, but scrollTop did not go down.
 */
export function stickAfterScroll(stuck: boolean, prevTop: number, el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE) return true;
  if (el.scrollTop < prevTop) return false;
  return stuck;
}
