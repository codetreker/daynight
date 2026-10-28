import { useCallback, useLayoutEffect, useState } from "react";

export const taskPageSize = 20;

export type PaginationState = {
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly start: number;
  readonly end: number;
  readonly onPageChange: (page: number) => void;
};

export const usePagination = (total: number): PaginationState => {
  const [requestedPage, setRequestedPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(total / taskPageSize));
  const page = Math.min(requestedPage, pageCount);
  useLayoutEffect(() => {
    if (requestedPage !== page) setRequestedPage(page);
  }, [page, requestedPage]);
  const onPageChange = useCallback((next: number) => {
    if (!Number.isInteger(next) || next < 1 || next > pageCount) throw new RangeError("The requested task page does not exist.");
    setRequestedPage(next);
  }, [pageCount]);
  return { page, pageCount, total, start: total === 0 ? 0 : (page - 1) * taskPageSize + 1, end: Math.min(page * taskPageSize, total), onPageChange };
};
