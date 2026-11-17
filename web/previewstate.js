// The image index after the previous (-1) or next (+1) button; wraps around at both ends.
export const stepIndex = (index, delta, count) => (count ? (((index + delta) % count) + count) % count : 0);

export const counterText = (index, count) => `${count ? index + 1 : 0} / ${count}`;
