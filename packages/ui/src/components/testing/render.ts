/**
 * Minimal jsdom renderer for the component tests (no @testing-library/react in the pinned
 * dependency set). Everything runs inside React's `act` so effects flush synchronously.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  readonly container: HTMLElement;
  readonly root: Root;
  rerender(element: ReactElement): void;
  unmount(): void;
  /** `container.querySelector` that throws instead of returning null. */
  get(selector: string): HTMLElement;
  all(selector: string): HTMLElement[];
}

export function render(element: ReactElement): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    get(selector: string): HTMLElement {
      const el = container.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`render.get: no element matches "${selector}"`);
      return el;
    },
    all(selector: string): HTMLElement[] {
      return Array.from(container.querySelectorAll<HTMLElement>(selector));
    },
  };
}

/** Dispatches a bubbling DOM event inside `act`. */
export function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

export function click(target: EventTarget): void {
  fire(target, new MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function keydown(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  fire(target, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}
