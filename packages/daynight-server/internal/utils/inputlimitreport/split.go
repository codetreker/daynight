package inputlimitreport

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
)

// Chunk describes one complete-record chunk in order, numbered from one.
type Chunk struct {
	Index   int    `json:"index"`
	Bytes   int64  `json:"bytes"`
	Records int64  `json:"records"`
	SHA256  string `json:"sha256"`
}

// Split streams a complete JSONL report to chunks without splitting records.
// The caller owns cleanup of any chunks created before an error. create must
// return a new destination for each index; Close errors are reported.
func Split(src io.Reader, create func(index int) (io.WriteCloser, error)) ([]Chunk, error) {
	return split(src, create, MaxRecordBytes, MaxChunkBytes, MaxReportBytes)
}

func split(src io.Reader, create func(int) (io.WriteCloser, error), recordLimit, chunkLimit int, reportLimit int64) (chunks []Chunk, resultErr error) {
	r := bufio.NewReaderSize(src, recordLimit+1)
	var dst io.WriteCloser
	var digest hash.Hash
	var current Chunk
	var total int64
	defer func() {
		if dst != nil {
			resultErr = errors.Join(resultErr, dst.Close())
		}
	}()
	finish := func() error {
		if dst == nil {
			return nil
		}
		err := dst.Close()
		dst = nil
		if err != nil {
			return fmt.Errorf("close chunk: %w", err)
		}
		current.SHA256 = hex.EncodeToString(digest.Sum(nil))
		chunks = append(chunks, current)
		return nil
	}
	for {
		line, err := r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return nil, ErrRecordBudget
		}
		if err == io.EOF && len(line) == 0 {
			break
		}
		if err != nil {
			if err == io.EOF {
				return nil, fmt.Errorf("unterminated record: %w", ErrInvalidRecord)
			}
			return nil, fmt.Errorf("read report: %w", err)
		}
		if err := validateRecord(line[:len(line)-1], recordLimit); err != nil {
			return nil, err
		}
		if len(line) > chunkLimit {
			return nil, ErrRecordBudget
		}
		if total+int64(len(line)) > reportLimit {
			return nil, ErrReportBudget
		}
		if dst != nil && current.Bytes+int64(len(line)) > int64(chunkLimit) {
			if err := finish(); err != nil {
				return nil, err
			}
		}
		if dst == nil {
			current = Chunk{Index: len(chunks) + 1}
			dst, err = create(current.Index)
			if err != nil {
				return nil, fmt.Errorf("create chunk: %w", err)
			}
			if dst == nil {
				return nil, errors.New("create chunk returned nil destination")
			}
			digest = sha256.New()
		}
		n, err := dst.Write(line)
		if err == nil && n != len(line) {
			err = io.ErrShortWrite
		}
		if err != nil {
			return nil, fmt.Errorf("write chunk: %w", err)
		}
		_, _ = digest.Write(line)
		current.Bytes += int64(len(line))
		current.Records++
		total += int64(len(line))
	}
	if err := finish(); err != nil {
		return nil, err
	}
	return chunks, nil
}
