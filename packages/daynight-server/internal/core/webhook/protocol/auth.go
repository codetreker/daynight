package protocol

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Authenticate signs the already persisted event bytes with the current keys.
// Keys are raw 32-byte secrets in active-then-overlap order.
func Authenticate(eventID string, body []byte, keys [][]byte, at time.Time) (http.Header, error) {
	id, _, err := Decode(body)
	if err != nil || id != eventID || !validTime(at) || len(keys) < 1 || len(keys) > 2 {
		return nil, errors.New("invalid webhook authentication input")
	}
	timestamp := strconv.FormatInt(at.Unix(), 10)
	prefix := eventID + "." + timestamp + "."
	signatures := make([]string, 0, len(keys))
	for _, key := range keys {
		if len(key) != 32 {
			return nil, errors.New("invalid webhook signing key")
		}
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(prefix))
		_, _ = mac.Write(body)
		signatures = append(signatures, "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	}
	return http.Header{"Webhook-Id": {eventID}, "Webhook-Timestamp": {timestamp}, "Webhook-Signature": {strings.Join(signatures, " ")}}, nil
}
