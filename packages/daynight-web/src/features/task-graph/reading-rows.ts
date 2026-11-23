import { useCallback, useState } from 'react';

// Geometry depends on the presence of the row, not its changing values.
export const useReadingRows = () => {
  const [rows, setRows] = useState<ReadonlySet<string>>(() => new Set());
  const onReadingRowChange = useCallback((id: string, visible: boolean) => {
    setRows((current) => {
      if (current.has(id) === visible) return current;
      const next = new Set(current);
      if (visible) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  return { rows, onReadingRowChange };
};
