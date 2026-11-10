package protocol

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Result is a protocol interpretation, not a claim that external processing finished.
// RetryAfterInvalid distinguishes a malformed header from an absent header.
type Result struct {
	Category          string
	Reason            string
	RetryNotBefore    *time.Time
	RetryAfterInvalid bool
}

// Classify interprets a final generic HTTP response. Body is irrelevant to this adapter.
func Classify(status int, retryAfter string, now time.Time) Result {
	if status >= 200 && status < 300 {
		return Result{Category: "acknowledged"}
	}
	result := Result{Category: "http_error"}
	if status == 410 {
		result.Reason = "receiver_retired"
	}
	if (status == 429 || status == 503) && retryAfter != "" {
		when, ok := parseRetryAfter(retryAfter, now)
		if ok {
			result.RetryNotBefore = &when
		} else {
			result.RetryAfterInvalid = true
		}
	}
	return result
}

func parseRetryAfter(raw string, now time.Time) (time.Time, bool) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return time.Time{}, false
	}
	if strings.IndexFunc(v, func(r rune) bool { return r < '0' || r > '9' }) == -1 {
		n, err := strconv.ParseUint(v, 10, 64)
		// A large but syntactically valid delay must not become an earlier retry.
		if err != nil || n > uint64((1<<63-1)/int64(time.Second)) {
			return time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC), true
		}
		return now.Add(time.Duration(n) * time.Second), true
	}
	when, err := http.ParseTime(v)
	if err != nil {
		return time.Time{}, false
	}
	return when, true
}
