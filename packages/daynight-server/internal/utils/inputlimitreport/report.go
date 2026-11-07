// Package inputlimitreport writes and splits bounded JSON Lines reports.
package inputlimitreport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	MaxRecordBytes = 16 << 10
	MaxReportBytes = 64 << 20
	MaxChunkBytes  = 4 << 20
)

var (
	ErrInvalidRecord = errors.New("invalid JSONL record")
	ErrRecordBudget  = errors.New("JSONL record budget exceeded")
	ErrReportBudget  = errors.New("JSONL report budget exceeded")
	ErrIncomplete    = errors.New("report is incomplete")
	ErrFinished      = errors.New("report already finished")
)

// Writer reserves a full record for the final summary. Callers must bound the
// fields before encoding them; WriteRecord accepts an already encoded object.
type Writer struct {
	out        io.Writer
	bytes      int64
	records    int64
	incomplete bool
	broken     error
	finished   bool
	maxRecord  int
	maxReport  int64
}

func New(out io.Writer) *Writer {
	return &Writer{out: out, maxRecord: MaxRecordBytes, maxReport: MaxReportBytes}
}

// Bytes and Records include every successfully written record, including the
// summary after Finish. The bytes include line terminators.
func (w *Writer) Bytes() int64   { return w.bytes }
func (w *Writer) Records() int64 { return w.records }

func validateRecord(record []byte, limit int) error {
	if len(record)+1 > limit {
		return ErrRecordBudget
	}
	trimmed := bytes.TrimSpace(record)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' ||
		bytes.ContainsAny(record, "\r\n") || !json.Valid(record) {
		return ErrInvalidRecord
	}
	return nil
}

// WriteRecord writes and flushes one JSON object. On a budget or validation
// failure, Finish can still write an incomplete summary into the reservation.
func (w *Writer) WriteRecord(record []byte) error {
	if w.finished {
		return ErrFinished
	}
	if w.broken != nil {
		return w.broken
	}
	if w.incomplete {
		return ErrIncomplete
	}
	if err := validateRecord(record, w.maxRecord); err != nil {
		w.incomplete = true
		return err
	}
	if w.bytes+int64(len(record)+1) > w.maxReport-int64(w.maxRecord) {
		w.incomplete = true
		return ErrReportBudget
	}
	return w.write(record)
}

// Finish writes the final summary. It requires a type of "summary" and an
// explicit complete value; an exhausted report cannot claim completion.
func (w *Writer) Finish(record []byte) error {
	if w.finished {
		return ErrFinished
	}
	if w.broken != nil {
		return w.broken
	}
	if err := validateRecord(record, w.maxRecord); err != nil {
		w.incomplete = true
		return err
	}
	if !uniqueJSONKeys(record) || !canonicalSummary(record) {
		w.incomplete = true
		return ErrInvalidRecord
	}
	var summary struct {
		Type     string `json:"type"`
		Complete *bool  `json:"complete"`
		Clear    bool   `json:"clear"`
		Status   string `json:"status"`
	}
	if err := json.Unmarshal(record, &summary); err != nil || summary.Type != "summary" || summary.Complete == nil {
		return ErrInvalidRecord
	}
	if w.incomplete && *summary.Complete {
		return ErrIncomplete
	}
	if !*summary.Complete && (summary.Clear || summary.Status == "clear") {
		return ErrIncomplete
	}
	if w.bytes+int64(len(record)+1) > w.maxReport {
		return ErrReportBudget
	}
	if err := w.write(record); err != nil {
		return err
	}
	w.finished = true
	return nil
}

func (w *Writer) write(record []byte) error {
	line := make([]byte, len(record)+1)
	copy(line, record)
	line[len(record)] = '\n'
	n, err := w.out.Write(line)
	if err == nil && n != len(line) {
		err = io.ErrShortWrite
	}
	if err == nil {
		if f, ok := w.out.(interface{ Flush() error }); ok {
			err = f.Flush()
		}
	}
	if err != nil {
		w.broken = fmt.Errorf("write report: %w", err)
		return w.broken
	}
	w.bytes += int64(len(line))
	w.records++
	return nil
}
