const owners = new WeakMap<HTMLElement, { count: number; original: boolean }>();

export const acquireInert = (element: HTMLElement): (() => void) => {
  let ownership = owners.get(element);
  if (ownership === undefined) {
    ownership = { count: 0, original: element.hasAttribute('inert') };
    owners.set(element, ownership);
  }
  ownership.count++;
  element.setAttribute('inert', '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownership.count--;
    if (ownership.count === 0) {
      if (!ownership.original) element.removeAttribute('inert');
      owners.delete(element);
    }
  };
};
