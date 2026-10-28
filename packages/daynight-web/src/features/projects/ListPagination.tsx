import { useI18n } from "../../i18n/LocaleProvider";
import type { PaginationState } from "./usePagination";

export const ListPagination = ({ label, page, pageCount, total, start, end, onPageChange }: PaginationState & { readonly label: string }) => {
  const { messages: { workspace: { pagination: m } } } = useI18n();
  if (pageCount <= 1) return null;
  return <nav className="list-pagination" aria-label={m.label({ list: label })}>
    <span className="list-pagination-range" aria-live="polite" aria-atomic="true">{m.range({ start, end, total })}</span>
    <div className="list-pagination-controls">
      <button className="button" type="button" disabled={page === 1} onClick={() => onPageChange(page - 1)}>{m.previous}</button>
      <span className="list-pagination-page">{m.page({ page, pages: pageCount })}</span>
      <button className="button" type="button" disabled={page === pageCount} onClick={() => onPageChange(page + 1)}>{m.next}</button>
    </div>
  </nav>;
};
