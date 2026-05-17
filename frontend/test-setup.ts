import '@testing-library/jest-dom';

// Polyfill HTMLDialogElement for jsdom (which lacks native dialog support)
if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) {
  (HTMLDialogElement as any).prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  (HTMLDialogElement as any).prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}
