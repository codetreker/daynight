// coverage-normalize combines duplicate blocks in a Go atomic coverage profile.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type block struct {
	location   string
	statements int
	count      int
}

func number(s string, positive bool) (int, error) {
	if s == "" || (len(s) > 1 && s[0] == '0') || (positive && s == "0") {
		return 0, errors.New("invalid number")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, errors.New("invalid number")
		}
	}
	return strconv.Atoi(s)
}

func parseRow(row string) (string, int, int, error) {
	location, rest, ok := strings.Cut(row, " ")
	if !ok {
		return "", 0, 0, errors.New("missing counts")
	}
	stmt, count, ok := strings.Cut(rest, " ")
	if !ok {
		return "", 0, 0, errors.New("missing count")
	}
	statements, err := number(stmt, false)
	if err != nil {
		return "", 0, 0, err
	}
	n, err := number(count, false)
	if err != nil {
		return "", 0, 0, err
	}
	colon := strings.LastIndexByte(location, ':')
	if colon <= 0 || strings.ContainsAny(location[:colon], " \t\r\n") {
		return "", 0, 0, errors.New("invalid filename")
	}
	start, end, ok := strings.Cut(location[colon+1:], ",")
	if !ok {
		return "", 0, 0, errors.New("missing block end")
	}
	sl, sc, ok := strings.Cut(start, ".")
	if !ok {
		return "", 0, 0, errors.New("invalid block start")
	}
	el, ec, ok := strings.Cut(end, ".")
	if !ok {
		return "", 0, 0, errors.New("invalid block end")
	}
	var values [4]int
	for i, s := range [...]string{sl, sc, el, ec} {
		values[i], err = number(s, true)
		if err != nil {
			return "", 0, 0, err
		}
	}
	if values[2] < values[0] || (values[2] == values[0] && values[3] < values[1]) {
		return "", 0, 0, errors.New("invalid block range")
	}
	return location, statements, n, nil
}

// Go's coverage readers parse counts as int and add duplicate atomic counts.
// Refusing overflow prevents a valid-looking replacement with different results.
func normalize(path, temporary string, interrupted <-chan os.Signal) (err error) {
	profilePath, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	tempPath, err := filepath.Abs(temporary)
	if err != nil {
		return err
	}
	if profilePath == tempPath || filepath.Dir(profilePath) != filepath.Dir(tempPath) {
		return errors.New("temporary file must be distinct and in the profile directory")
	}
	tempInfo, err := os.Lstat(tempPath)
	if err != nil {
		return err
	}
	if !tempInfo.Mode().IsRegular() {
		return errors.New("temporary path is not a regular file")
	}
	defer os.Remove(tempPath)

	profileInfo, err := os.Lstat(profilePath)
	if err != nil {
		return err
	}
	if !profileInfo.Mode().IsRegular() {
		return errors.New("profile is not a regular file")
	}
	if os.SameFile(profileInfo, tempInfo) {
		return errors.New("temporary file aliases profile")
	}
	input, err := os.Open(path)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("profile is not a regular file")
	}

	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	if !scanner.Scan() || scanner.Text() != "mode: atomic" {
		if scanner.Err() != nil {
			return scanner.Err()
		}
		return errors.New("profile must start with mode: atomic")
	}
	index := make(map[string]int)
	var blocks []block
	line := 1
	maxInt := int(^uint(0) >> 1)
	for scanner.Scan() {
		line++
		select {
		case <-interrupted:
			return errors.New("interrupted")
		default:
		}
		location, statements, count, err := parseRow(scanner.Text())
		if err != nil {
			return fmt.Errorf("invalid profile row %d: %w", line, err)
		}
		if i, ok := index[location]; ok {
			if blocks[i].statements != statements {
				return fmt.Errorf("inconsistent statement count at row %d", line)
			}
			if count > maxInt-blocks[i].count {
				return fmt.Errorf("count overflow at row %d", line)
			}
			blocks[i].count += count
		} else {
			index[location] = len(blocks)
			blocks = append(blocks, block{location, statements, count})
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(blocks) == 0 {
		return errors.New("profile has no blocks")
	}
	if err := input.Close(); err != nil {
		return err
	}
	select {
	case <-interrupted:
		return errors.New("interrupted")
	default:
	}

	output, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	defer output.Close()
	if err := output.Chmod(info.Mode().Perm()); err != nil {
		return err
	}
	writer := bufio.NewWriter(output)
	if _, err := io.WriteString(writer, "mode: atomic\n"); err != nil {
		return err
	}
	for _, b := range blocks {
		select {
		case <-interrupted:
			return errors.New("interrupted")
		default:
		}
		if _, err := fmt.Fprintf(writer, "%s %d %d\n", b.location, b.statements, b.count); err != nil {
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	select {
	case <-interrupted:
		return errors.New("interrupted")
	default:
	}
	return os.Rename(tempPath, profilePath)
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: coverage-normalize PROFILE TEMP_PATH")
		os.Exit(2)
	}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)
	if err := normalize(os.Args[1], os.Args[2], interrupt); err != nil {
		fmt.Fprintln(os.Stderr, "coverage normalization failed:", err)
		os.Exit(1)
	}
}
