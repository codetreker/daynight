// Package redis implements the monitoring store using a single expiring string per worker.
package redis

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/google/uuid"
	redisclient "github.com/redis/go-redis/v9"
)

const (
	TTL              = 3600 * time.Second
	operationTimeout = 200 * time.Millisecond
	headerLimit      = 2 * 1024
	bodyLimit        = 256 * 1024
	valueLimit       = headerLimit + bodyLimit
)

var ErrInvalidFrame = errors.New("invalid monitoring frame")

type Store struct {
	client *redisclient.Client
	ttl    time.Duration
}

func options(rawURL string) (*redisclient.Options, error) {
	u, parseErr := url.Parse(rawURL)
	if parseErr != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Hostname() == "" || u.Fragment != "" {
		return nil, fmt.Errorf("invalid Redis URL")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return nil, fmt.Errorf("invalid Redis URL")
	}
	for name, values := range query {
		if name != "db" || len(values) != 1 || values[0] == "" {
			return nil, fmt.Errorf("invalid Redis URL")
		}
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, fmt.Errorf("invalid Redis URL")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("invalid Redis URL")
		}
	}
	opts, err := redisclient.ParseURL(rawURL)
	if err != nil || opts.DB < 0 || int64(opts.DB) > 2147483647 {
		return nil, fmt.Errorf("invalid Redis URL")
	}
	opts.MaxRetries = -1
	opts.DialerRetries = 1
	opts.ContextTimeoutEnabled = true
	opts.DialTimeout = operationTimeout
	opts.ReadTimeout = operationTimeout
	opts.WriteTimeout = operationTimeout
	opts.PoolTimeout = operationTimeout
	return opts, nil
}

// ValidateURL validates a nonempty monitoring Redis URL without connecting.
func ValidateURL(rawURL string) error { _, err := options(rawURL); return err }

// New creates a monitoring-only connection; availability is checked by operations.
func New(rawURL string) (*Store, error) {
	opts, err := options(rawURL)
	if err != nil {
		return nil, err
	}
	return &Store{client: redisclient.NewClient(opts), ttl: TTL}, nil
}

func (s *Store) Close() error { return s.client.Close() }

func validUUID(v string) bool {
	u, err := uuid.Parse(v)
	return err == nil && u.String() == v
}
func validSequence(v string) bool {
	if v == "" || v[0] == '0' {
		return false
	}
	for _, c := range v {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return err == nil && n > 0
}
func validObject(raw []byte) bool {
	if len(raw) == 0 || raw[0] != '{' || !json.Valid(raw) {
		return false
	}
	var compact bytes.Buffer
	return json.Compact(&compact, raw) == nil && bytes.Equal(compact.Bytes(), raw)
}
func key(id store.MonitoringIdentity) (string, error) {
	if !validUUID(id.UserID) || !validUUID(id.WorkerID) {
		return "", errors.New("invalid monitoring identity")
	}
	return "dn:worker-monitoring:{" + id.UserID + ":" + id.WorkerID + "}", nil
}

type header struct {
	FormatVersion int             `json:"formatVersion"`
	Revision      string          `json:"revision"`
	RunID         string          `json:"runId"`
	Sequence      string          `json:"sequence"`
	BodyDigest    string          `json:"bodyDigest"`
	ReceivedAtMs  int64           `json:"receivedAtMs"`
	ExpiresAtMs   int64           `json:"expiresAtMs"`
	Summary       json.RawMessage `json:"summary"`
}

func parseHeader(frame []byte) (header, int, error) {
	var h header
	i := bytes.IndexByte(frame, '\n')
	if i < 0 || i+1 > headerLimit {
		return h, 0, ErrInvalidFrame
	}
	if _, err := jsonobject.Decode(frame[:i], "monitoring header", "formatVersion", "revision", "runId", "sequence", "bodyDigest", "receivedAtMs", "expiresAtMs", "summary"); err != nil {
		return h, 0, fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	dec := json.NewDecoder(bytes.NewReader(frame[:i]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return h, 0, fmt.Errorf("%w: %v", ErrInvalidFrame, err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return h, 0, ErrInvalidFrame
	}
	digest, err := hex.DecodeString(h.BodyDigest)
	if h.FormatVersion != 1 || !validUUID(h.Revision) || !validUUID(h.RunID) || !validSequence(h.Sequence) || err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != h.BodyDigest || h.ReceivedAtMs <= 0 || h.ExpiresAtMs <= h.ReceivedAtMs || h.ExpiresAtMs > 9007199254740991 || !validObject(h.Summary) {
		return h, 0, ErrInvalidFrame
	}
	if _, err := monitoring.ParseSummary(h.Summary); err != nil {
		return h, 0, fmt.Errorf("%w: invalid summary: %v", ErrInvalidFrame, err)
	}
	return h, i + 1, nil
}
func (h header) receipt() store.MonitoringReceipt {
	return store.MonitoringReceipt{Revision: h.Revision, RunID: h.RunID, Sequence: h.Sequence, ReceivedAt: time.UnixMilli(h.ReceivedAtMs).UTC(), ExpiresAt: time.UnixMilli(h.ExpiresAtMs).UTC()}
}
func parseValue(frame []byte, full bool) (*store.MonitoringValue, error) {
	h, start, err := parseHeader(frame)
	if err != nil {
		return nil, err
	}
	v := &store.MonitoringValue{Receipt: h.receipt(), Summary: h.Summary}
	if full {
		body := frame[start:]
		if len(frame) > valueLimit || len(body) > bodyLimit || !validObject(body) {
			return nil, ErrInvalidFrame
		}
		digest := sha256.Sum256(body)
		if hex.EncodeToString(digest[:]) != h.BodyDigest {
			return nil, ErrInvalidFrame
		}
		v.Body = append(json.RawMessage(nil), body...)
	}
	return v, nil
}

// The script checks the entire old header before the only mutating command.
// Sequence comparison is lexical after comparing lengths, never a Lua number.
const casScript = `
local function uuid(s)
  return type(s)=='string' and #s==36 and string.match(s,'^[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+%-[0-9a-f]+$') and string.sub(s,9,9)=='-' and string.sub(s,14,14)=='-' and string.sub(s,19,19)=='-' and string.sub(s,24,24)=='-'
end
local function sequence(s)
  return type(s)=='string' and string.match(s,'^[1-9][0-9]*$') and (#s<19 or (#s==19 and s<='9223372036854775807'))
end
local t=redis.call('TYPE',KEYS[1]).ok
if t~='none' and t~='string' then return redis.error_reply('invalid monitoring key type') end
local prefix=''
if t=='string' then prefix=redis.call('GETRANGE',KEYS[1],0,2047) end
if (t=='none' and ARGV[9]~='0') or (t=='string' and (ARGV[9]~='1' or prefix~=ARGV[10])) then return {'retry'} end
local old=nil
if t=='string' then
  local n=string.find(prefix,'\n',1,true)
  if not n then return redis.error_reply('invalid monitoring frame') end
  local ok,h=pcall(cjson.decode,string.sub(prefix,1,n-1))
  if not ok or type(h)~='table' then return redis.error_reply('invalid monitoring header') end
  local fields={formatVersion=true,revision=true,runId=true,sequence=true,bodyDigest=true,receivedAtMs=true,expiresAtMs=true,summary=true}
  for k,_ in pairs(h) do if not fields[k] then return redis.error_reply('invalid monitoring header') end end
  if h.formatVersion~=1 or not uuid(h.revision) or not uuid(h.runId) or not sequence(h.sequence) or type(h.bodyDigest)~='string' or #h.bodyDigest~=64 or not string.match(h.bodyDigest,'^[0-9a-f]+$') or type(h.receivedAtMs)~='number' or h.receivedAtMs<=0 or h.receivedAtMs~=math.floor(h.receivedAtMs) or type(h.expiresAtMs)~='number' or h.expiresAtMs<=h.receivedAtMs or h.expiresAtMs~=math.floor(h.expiresAtMs) or h.expiresAtMs>9007199254740991 or type(h.summary)~='table' then return redis.error_reply('invalid monitoring header') end
  local raw=string.sub(prefix,1,n-1)
  local expected='{"formatVersion":1,"revision":"'..h.revision..'","runId":"'..h.runId..'","sequence":"'..h.sequence..'","bodyDigest":"'..h.bodyDigest..'","receivedAtMs":'..string.format('%.0f',h.receivedAtMs)..',"expiresAtMs":'..string.format('%.0f',h.expiresAtMs)..',"summary":{'
  if string.sub(raw,1,#expected)~=expected or string.sub(raw,-2)~='}}' then return redis.error_reply('invalid monitoring header') end
  old=h
end
if not old and ARGV[1]~='' then return {'state-lost'} end
if old and old.runId==ARGV[3] then
  if old.sequence==ARGV[4] then
    if old.bodyDigest==ARGV[5] then return {'duplicate',old.revision,old.runId,old.sequence,string.format('%.0f',old.receivedAtMs),string.format('%.0f',old.expiresAtMs)} end
    return {'sample-conflict'}
  end
  if #old.sequence>#ARGV[4] or (#old.sequence==#ARGV[4] and old.sequence>ARGV[4]) then return {'sequence-stale'} end
end
if old and old.revision~=ARGV[1] then return {'revision-conflict'} end
local now=redis.call('TIME')
local received=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)
local expires=received+tonumber(ARGV[8])*1000
local head='{"formatVersion":1,"revision":"'..ARGV[2]..'","runId":"'..ARGV[3]..'","sequence":"'..ARGV[4]..'","bodyDigest":"'..ARGV[5]..'","receivedAtMs":'..string.format('%.0f',received)..',"expiresAtMs":'..string.format('%.0f',expires)..',"summary":'..ARGV[6]..'}\n'
if #head>2048 or #ARGV[7]>262144 or #head+#ARGV[7]>264192 then return redis.error_reply('monitoring frame too large') end
redis.call('SET',KEYS[1],head..ARGV[7],'EX',ARGV[8])
return {'accepted',ARGV[2],ARGV[3],ARGV[4],string.format('%.0f',received),string.format('%.0f',expires)}
`

func classifyFailure(err error) error {
	if err == nil {
		return nil
	}
	kind := "other"
	var network *net.OpError
	var redisErr redisclient.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		kind = "deadline"
	case errors.Is(err, context.Canceled):
		kind = "cancelled"
	case errors.Is(err, ErrInvalidFrame):
		kind = "format"
	case errors.As(err, &redisErr):
		switch {
		case strings.HasPrefix(redisErr.Error(), "OOM "):
			kind = "oom"
		case strings.HasPrefix(redisErr.Error(), "WRONGTYPE "), strings.Contains(redisErr.Error(), "invalid monitoring key type"):
			kind = "type"
		case strings.Contains(redisErr.Error(), "invalid monitoring"):
			kind = "format"
		default:
			kind = "server"
		}
	case errors.As(err, &network):
		kind = "network"
	}
	return &store.MonitoringError{Kind: kind, Cause: err}
}

func (s *Store) CompareAndSet(ctx context.Context, id store.MonitoringIdentity, expected *string, c store.MonitoringCandidate) (result store.MonitoringCASResult, failure error) {
	defer func() { failure = classifyFailure(failure) }()
	k, err := key(id)
	if err != nil {
		return result, err
	}
	if !validUUID(c.RunID) || !validSequence(c.Sequence) || !validObject(c.Body) || len(c.Body) > bodyLimit || !validObject(c.Summary) || len(c.Summary) > headerLimit {
		return result, errors.New("invalid monitoring candidate")
	}
	if _, err := monitoring.ParseSummary(c.Summary); err != nil {
		return result, fmt.Errorf("invalid monitoring summary: %w", err)
	}
	exp := ""
	if expected != nil {
		if !validUUID(*expected) {
			return result, errors.New("invalid monitoring revision")
		}
		exp = *expected
	}
	digest := sha256.Sum256(c.Body)
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	var v []string
	for {
		pre, err := s.client.Eval(ctx, rangeScript, []string{k}, headerLimit-1).Slice()
		if err != nil {
			return result, fmt.Errorf("monitoring CAS preflight: %w", err)
		}
		exists, prefix, err := rangeResult(pre)
		if err != nil {
			return result, err
		}
		if exists {
			if _, _, err := parseHeader([]byte(prefix)); err != nil {
				return result, err
			}
		}
		flag := "0"
		if exists {
			flag = "1"
		}
		v, err = s.client.Eval(ctx, casScript, []string{k}, exp, uuid.NewString(), c.RunID, c.Sequence, hex.EncodeToString(digest[:]), string(c.Summary), string(c.Body), int64(s.ttl/time.Second), flag, prefix).StringSlice()
		if err != nil {
			var redisErr redisclient.Error
			if !errors.As(err, &redisErr) {
				return result, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, fmt.Errorf("monitoring CAS: %w", err))
			}
			return result, fmt.Errorf("monitoring CAS: %w", err)
		}
		if len(v) != 1 || v[0] != "retry" {
			break
		}
		if err := ctx.Err(); err != nil {
			return result, fmt.Errorf("monitoring CAS preflight: %w", err)
		}
	}

	if len(v) < 1 {
		return result, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, ErrInvalidFrame)
	}
	result.Kind = store.MonitoringCASKind(v[0])
	switch result.Kind {
	case store.MonitoringAccepted, store.MonitoringDuplicate:
		if len(v) != 6 || !validUUID(v[1]) || !validUUID(v[2]) || !validSequence(v[3]) {
			return store.MonitoringCASResult{}, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, ErrInvalidFrame)
		}
		received, e1 := strconv.ParseInt(v[4], 10, 64)
		expires, e2 := strconv.ParseInt(v[5], 10, 64)
		if e1 != nil || e2 != nil || received <= 0 || expires <= received {
			return store.MonitoringCASResult{}, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, ErrInvalidFrame)
		}
		result.Receipt = &store.MonitoringReceipt{Revision: v[1], RunID: v[2], Sequence: v[3], ReceivedAt: time.UnixMilli(received).UTC(), ExpiresAt: time.UnixMilli(expires).UTC()}
	case store.MonitoringRevisionConflict, store.MonitoringSequenceStale, store.MonitoringSampleConflict, store.MonitoringStateLost:
		if len(v) != 1 {
			return store.MonitoringCASResult{}, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, ErrInvalidFrame)
		}
	default:
		return store.MonitoringCASResult{}, errors.Join(store.ErrMonitoringWriteOutcomeUnknown, ErrInvalidFrame)
	}
	return result, nil
}

// A zero-length string is corrupt, while a missing key is a valid result.
// Redis executes both observations atomically so concurrent creation cannot
// turn an absent read into a false corruption error.
const rangeScript = `
local value=redis.call('GETRANGE',KEYS[1],0,ARGV[1])
if value=='' and redis.call('EXISTS',KEYS[1])==0 then return {0,''} end
return {1,value}
`

func rangeResult(v []any) (bool, string, error) {
	if len(v) != 2 {
		return false, "", ErrInvalidFrame
	}
	present, ok := v[0].(int64)
	data, good := v[1].(string)
	if !ok || !good || (present != 0 && present != 1) || (present == 0 && data != "") {
		return false, "", ErrInvalidFrame
	}
	return present == 1, data, nil
}

// One script provides the Redis time and bounded values without a pipeline
// fallback that could redial implicitly after a failed connection attempt.
const readScript = `
local now=redis.call('TIME')
local out={now[1],now[2]}
for _,key in ipairs(KEYS) do
  local value=redis.call('GETRANGE',key,0,ARGV[1])
  if value=='' and redis.call('EXISTS',key)==0 then table.insert(out,{0,''}) else table.insert(out,{1,value}) end
end
return out
`

func (s *Store) read(ctx context.Context, ids []store.MonitoringIdentity, full bool) (time.Time, []*store.MonitoringValue, error) {
	keys := make([]string, len(ids))
	for i, id := range ids {
		k, err := key(id)
		if err != nil {
			return time.Time{}, nil, err
		}
		keys[i] = k
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	limit := headerLimit - 1
	if full {
		limit = valueLimit
	}
	data, err := s.client.Eval(ctx, readScript, keys, limit).Slice()
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("monitoring read: %w", err)
	}
	if len(data) != len(keys)+2 {
		return time.Time{}, nil, ErrInvalidFrame
	}
	secs, ok := data[0].(string)
	micros, ok2 := data[1].(string)
	if !ok || !ok2 {
		return time.Time{}, nil, ErrInvalidFrame
	}
	sec, e1 := strconv.ParseInt(secs, 10, 64)
	usec, e2 := strconv.ParseInt(micros, 10, 64)
	if e1 != nil || e2 != nil || sec <= 0 || usec < 0 || usec >= 1000000 {
		return time.Time{}, nil, ErrInvalidFrame
	}
	values := make([]*store.MonitoringValue, len(keys))
	for i, entry := range data[2:] {
		v, ok := entry.([]any)
		if !ok {
			return time.Time{}, nil, ErrInvalidFrame
		}
		exists, raw, e := rangeResult(v)
		if e != nil {
			return time.Time{}, nil, e
		}
		if !exists {
			continue
		}
		values[i], e = parseValue([]byte(raw), full)
		if e != nil {
			return time.Time{}, nil, e
		}
	}
	return time.Unix(sec, usec*1000).UTC(), values, nil
}
func (s *Store) Read(ctx context.Context, id store.MonitoringIdentity) (result store.MonitoringReadResult, failure error) {
	defer func() { failure = classifyFailure(failure) }()
	observed, values, err := s.read(ctx, []store.MonitoringIdentity{id}, true)
	if err != nil {
		return store.MonitoringReadResult{}, err
	}
	return store.MonitoringReadResult{ObservedAt: observed, Value: values[0]}, nil
}
func (s *Store) ReadSummaries(ctx context.Context, ids []store.MonitoringIdentity) (result store.MonitoringSummariesResult, failure error) {
	defer func() { failure = classifyFailure(failure) }()
	observed, values, err := s.read(ctx, ids, false)
	if err != nil {
		return store.MonitoringSummariesResult{}, err
	}
	return store.MonitoringSummariesResult{ObservedAt: observed, Values: values}, nil
}

var _ store.MonitoringStore = (*Store)(nil)
