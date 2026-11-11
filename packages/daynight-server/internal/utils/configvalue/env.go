package configvalue

import (
	"strconv"
	"time"
)

func Duration(value, field string) (time.Duration, error) {
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, &ConfigurationError{Field: field, Rule: "must be a positive Go duration"}
	}
	return duration, nil
}

func Flag(value, field string) (bool, error) {
	switch value {
	case "0":
		return false, nil
	case "1":
		return true, nil
	default:
		return false, &ConfigurationError{Field: field, Rule: "must be 0 or 1"}
	}
}

func Bytes(value, field string, allowZero bool) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || (!allowZero && n == 0) || strconv.FormatInt(n, 10) != value {
		rule := "must be a nonnegative decimal byte count"
		if !allowZero {
			rule = "must be a positive decimal byte count"
		}
		return 0, &ConfigurationError{Field: field, Rule: rule}
	}
	return n, nil
}
