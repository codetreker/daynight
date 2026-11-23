export const SelectionArrow = ({ className }: { readonly className: 'native-select__arrow' | 'select-trigger__arrow' }) =>
  <svg className={`${className} selection-control__arrow`} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
