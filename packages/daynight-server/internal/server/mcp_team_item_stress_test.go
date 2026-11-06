//go:build stress

package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func stressTeamItemContinue(t *testing.T, decoder *json.Decoder) {
	t.Helper()
	var response struct{ Continue bool }
	if err := decoder.Decode(&response); err != nil || !response.Continue {
		t.Fatalf("capacity continuation: %v", err)
	}
}

type stressTeamItemConfig struct {
	Endpoint, Token, Team, Member, Following string
	Size                                     int64
	Pattern                                  []byte
	Conditions                               []string
}

type stressTeamItemEnvelope struct {
	Data  json.RawMessage `json:"data"`
	Error struct {
		Code         string         `json:"code"`
		WriteOutcome string         `json:"writeOutcome"`
		Refs         map[string]any `json:"refs"`
	} `json:"error"`
}

type stressTeamItemInspection struct {
	Projection      string `json:"projection"`
	ContentIncluded bool   `json:"contentIncluded"`
	Revision        string `json:"revision"`
	Fields          []struct {
		Field     string `json:"field"`
		IsNull    bool   `json:"isNull"`
		SizeBytes string `json:"sizeBytes"`
	} `json:"fields"`
}

type stressTeamItemChunk struct {
	Revision, Field, Offset, ReadBytes, NextOffset, SizeBytes string
	EOF                                                       bool `json:"eof"`
	Encoding, Text, ContentBase64                             string
}

func stressTeamItemJSON(t *testing.T, data []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var result any
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func stressTeamItemCall(t *testing.T, session *sdk.ClientSession, tool string, arguments map[string]any, code string) stressTeamItemEnvelope {
	t.Helper()
	result, err := session.CallTool(t.Context(), &sdk.CallToolParams{Name: tool, Arguments: arguments})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	return stressTeamItemDecode(t, result, tool, arguments, code)
}

func stressTeamItemDecode(t *testing.T, result *sdk.CallToolResult, tool string, arguments map[string]any, code string) stressTeamItemEnvelope {
	t.Helper()
	if len(result.Content) != 1 {
		t.Fatalf("%s returned %d content blocks", tool, len(result.Content))
	}
	text, ok := result.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("%s did not return text content", tool)
	}
	structured, err := json.Marshal(result.StructuredContent)
	if err != nil || !reflect.DeepEqual(stressTeamItemJSON(t, structured), stressTeamItemJSON(t, []byte(text.Text))) {
		t.Fatalf("%s text/structured content differs: %v", tool, err)
	}
	// Consume the text representation throughout the directory/read/continuation
	// loop; parity alone would not prove a text-only client can follow references.
	var envelope stressTeamItemEnvelope
	if err := json.Unmarshal([]byte(text.Text), &envelope); err != nil {
		t.Fatal(err)
	}
	if result.IsError != (code != "") || envelope.Error.Code != code || envelope.Error.WriteOutcome != "" {
		t.Fatalf("%s expected %q, got error=%v code=%q writeOutcome=%q", tool, code, result.IsError, envelope.Error.Code, envelope.Error.WriteOutcome)
	}
	encoded, err := json.Marshal(result)
	limit := 16 << 10
	if n, ok := arguments["maxBytes"].(int); ok && n > 8192 {
		limit = 8 << 20
	}
	if err != nil || len(encoded) > limit {
		t.Fatalf("%s encoded CallToolResult=%d exceeds %d: %v", tool, len(encoded), limit, err)
	}
	return envelope
}

func stressTeamItemOffset(t *testing.T, value string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != value {
		t.Fatalf("noncanonical byte offset %q: %v", value, err)
	}
	return n
}

// TestStressMCPTeamItemClientProcess is launched only by the server-side stress
// test. A separate process keeps SDK decoding and reconstruction out of the
// server heap measurements, and no whole-field buffer is retained by either.
func TestStressMCPTeamItemClientProcess(t *testing.T) {
	if os.Getenv("DAYNIGHT_MCP_ITEM_CLIENT_PROCESS") != "1" {
		t.Skip("capacity client subprocess")
	}
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	decoder := json.NewDecoder(os.Stdin)
	var input stressTeamItemConfig
	if err := decoder.Decode(&input); err != nil {
		t.Fatal(err)
	}
	if input.Size <= 0 || len(input.Pattern) == 0 {
		t.Fatal("capacity client input is incomplete")
	}
	session := mcpPATClient(t, input.Endpoint, input.Token)
	var cursor any
	var continuation string
	var readArguments map[string]any
	for range 3 {
		args := map[string]any{"team": input.Team, "limit": 100}
		if cursor != nil {
			args["cursor"] = cursor
		}
		result, err := session.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_member_list", Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		code := ""
		if result.IsError {
			code = "payload_too_large"
		}
		envelope := stressTeamItemDecode(t, result, "team_member_list", args, code)
		if code != "" {
			var ok bool
			continuation, ok = envelope.Error.Refs["cursorAfterItem"].(string)
			if !ok || continuation == "" {
				t.Fatal("oversized item omitted its continuation")
			}
			readArguments, ok = envelope.Error.Refs["readArguments"].(map[string]any)
			if !ok || envelope.Error.Refs["readTool"] != "team_item_read" || readArguments["userId"] != input.Member {
				t.Fatal("oversized item omitted its complete-read reference")
			}
			break
		}
		var page struct {
			NextCursor *string `json:"nextCursor"`
		}
		if err := json.Unmarshal(envelope.Data, &page); err != nil || page.NextCursor == nil {
			t.Fatalf("directory terminated before oversized member: %v", err)
		}
		cursor = *page.NextCursor
	}
	if readArguments == nil {
		t.Fatal("oversized member boundary was not reached")
	}
	inspection := stressTeamItemCall(t, session, "team_item_read", readArguments, "")
	var metadata stressTeamItemInspection
	if err := json.Unmarshal(inspection.Data, &metadata); err != nil || metadata.Projection != "metadata" || metadata.ContentIncluded || metadata.Revision == "" {
		t.Fatalf("invalid inspection: %v", err)
	}
	seen := map[string]bool{}
	for _, field := range metadata.Fields {
		seen[field.Field] = true
		switch field.Field {
		case "profile.name":
			if field.IsNull || stressTeamItemOffset(t, field.SizeBytes) != input.Size {
				t.Fatal("large name metadata differs from source")
			}
		case "profile.email":
			if !field.IsNull || field.SizeBytes != "0" {
				t.Fatal("null email was not preserved")
			}
		case "profile.avatarUrl":
			if field.IsNull || field.SizeBytes != "0" {
				t.Fatal("empty avatar URL was not preserved")
			}
		default:
			t.Fatalf("unexpected profile field %s", field.Field)
		}
	}
	if len(seen) != 3 {
		t.Fatal("inspection omitted a profile field")
	}
	args := func(offset int64) map[string]any {
		return map[string]any{"kind": "member", "team": input.Team, "userId": input.Member, "action": "chunk", "revision": metadata.Revision, "field": "profile.name", "offset": strconv.FormatInt(offset, 10), "format": "base64", "maxBytes": 512 << 10}
	}
	for i, condition := range input.Conditions {
		if i > 0 {
			fmt.Fprintln(os.Stdout, "MCP_ITEM_BEFORE_INSPECT "+condition)
			stressTeamItemContinue(t, decoder)
			warm := stressTeamItemCall(t, session, "team_item_read", readArguments, "")
			var repeated stressTeamItemInspection
			if err := json.Unmarshal(warm.Data, &repeated); err != nil || repeated.Revision != metadata.Revision {
				t.Fatalf("warm inspection changed: %v", err)
			}
		}
		fmt.Fprintln(os.Stdout, "MCP_ITEM_AFTER_INSPECT "+condition)
		stressTeamItemContinue(t, decoder)
		for _, position := range []int64{0, input.Size / 2, input.Size - (512 << 10)} {
			fmt.Fprintf(os.Stdout, "MCP_ITEM_BEFORE_PROBE %s %d\n", condition, position)
			stressTeamItemContinue(t, decoder)
			envelope := stressTeamItemCall(t, session, "team_item_read", args(position), "")
			var probe stressTeamItemChunk
			if err := json.Unmarshal(envelope.Data, &probe); err != nil || probe.ReadBytes != "524288" || probe.Offset != strconv.FormatInt(position, 10) {
				t.Fatalf("sampled chunk at %d: %v", position, err)
			}
			fmt.Fprintln(os.Stdout, "MCP_ITEM_AFTER_PROBE "+condition)
			stressTeamItemContinue(t, decoder)
		}
	}
	fmt.Fprintln(os.Stdout, "MCP_ITEM_BEFORE_STREAM")
	stressTeamItemContinue(t, decoder)
	textArgs := args(0)
	delete(textArgs, "format")
	delete(textArgs, "maxBytes")
	textResult := stressTeamItemCall(t, session, "team_item_read", textArgs, "")
	var textChunk stressTeamItemChunk
	if err := json.Unmarshal(textResult.Data, &textChunk); err != nil || textChunk.Encoding != "utf8" || textChunk.Text == "" || stressTeamItemOffset(t, textChunk.ReadBytes) != int64(len(textChunk.Text)) {
		t.Fatalf("default text chunk: %v", err)
	}
	hash := sha256.New()
	var offset int64
	var calls int
	started := time.Now()
	for offset < input.Size {
		envelope := stressTeamItemCall(t, session, "team_item_read", args(offset), "")
		var chunk stressTeamItemChunk
		if err := json.Unmarshal(envelope.Data, &chunk); err != nil {
			t.Fatal(err)
		}
		data, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
		if err != nil || chunk.Encoding != "base64" || chunk.Revision != metadata.Revision || chunk.Field != "profile.name" || stressTeamItemOffset(t, chunk.Offset) != offset || stressTeamItemOffset(t, chunk.ReadBytes) != int64(len(data)) || stressTeamItemOffset(t, chunk.NextOffset) != offset+int64(len(data)) || stressTeamItemOffset(t, chunk.SizeBytes) != input.Size || len(data) == 0 || len(data) > 512<<10 || chunk.EOF != (offset+int64(len(data)) == input.Size) {
			t.Fatalf("invalid chunk at %d: bytes=%d error=%v", offset, len(data), err)
		}
		for i, b := range data {
			if b != input.Pattern[(offset+int64(i))%int64(len(input.Pattern))] {
				t.Fatalf("source byte differs at %d", offset+int64(i))
			}
		}
		_, _ = hash.Write(data)
		offset += int64(len(data))
		calls++
	}
	eof := stressTeamItemCall(t, session, "team_item_read", args(offset), "")
	var end stressTeamItemChunk
	if err := json.Unmarshal(eof.Data, &end); err != nil || !end.EOF || end.ReadBytes != "0" || end.NextOffset != strconv.FormatInt(offset, 10) || end.ContentBase64 != "" {
		t.Fatalf("explicit EOF is invalid: %v", err)
	}
	page := stressTeamItemCall(t, session, "team_member_list", map[string]any{"team": input.Team, "cursor": continuation}, "")
	var remaining struct {
		Items []struct {
			UserID string `json:"userId"`
		} `json:"items"`
		NextCursor *string `json:"nextCursor"`
	}
	if err := json.Unmarshal(page.Data, &remaining); err != nil || len(remaining.Items) != 1 || remaining.Items[0].UserID != input.Following || remaining.NextCursor != nil {
		t.Fatalf("continuation omitted following member or termination: %v", err)
	}
	partial := stressTeamItemCall(t, session, "team_item_read", args(0), "")
	var firstPartial stressTeamItemChunk
	if err := json.Unmarshal(partial.Data, &firstPartial); err != nil || firstPartial.NextOffset != "524288" {
		t.Fatalf("partial read before mutation: %v", err)
	}
	fmt.Fprintln(os.Stdout, "MCP_ITEM_BEFORE_CHANGE")
	var changed struct{ Changed bool }
	if err := decoder.Decode(&changed); err != nil || !changed.Changed {
		t.Fatalf("source change acknowledgment: %v", err)
	}
	stressTeamItemCall(t, session, "team_item_read", args(512<<10), "version_conflict")
	newInspection := stressTeamItemCall(t, session, "team_item_read", readArguments, "")
	var updated stressTeamItemInspection
	if err := json.Unmarshal(newInspection.Data, &updated); err != nil || updated.Revision == metadata.Revision {
		t.Fatalf("same assigned timestamp did not change revision: %v", err)
	}
	freshArgs := args(0)
	freshArgs["revision"], freshArgs["format"], freshArgs["maxBytes"] = updated.Revision, "text", 64
	fresh := stressTeamItemCall(t, session, "team_item_read", freshArgs, "")
	var restarted stressTeamItemChunk
	if err := json.Unmarshal(fresh.Data, &restarted); err != nil || restarted.Text != "replacement" || !restarted.EOF || restarted.Offset != "0" {
		t.Fatalf("restarted read mixed old content: %v", err)
	}
	report := struct {
		Bytes, Calls int64
		SHA256       string
		Milliseconds int64
	}{offset, int64(calls), hex.EncodeToString(hash.Sum(nil)), time.Since(started).Milliseconds()}
	b, _ := json.Marshal(report)
	fmt.Fprintf(os.Stdout, "MCP_ITEM_RECEIPT %s\n", b)
}

type stressTeamItemMemory struct {
	baseline, peak uint64
	once           sync.Once
	stop           chan struct{}
	done           chan struct{}
}

func stressTeamItemHeap(t *testing.T) *stressTeamItemMemory {
	t.Helper()
	runtime.GC()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	m := &stressTeamItemMemory{baseline: baseline.HeapAlloc, peak: baseline.HeapAlloc, stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(m.done)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			var current runtime.MemStats
			runtime.ReadMemStats(&current)
			m.peak = max(m.peak, current.HeapAlloc)
			select {
			case <-m.stop:
				return
			case <-ticker.C:
			}
		}
	}()
	t.Cleanup(func() { m.finish() })
	return m
}

func (m *stressTeamItemMemory) finish() uint64 {
	m.once.Do(func() { close(m.stop); <-m.done })
	return m.peak - m.baseline
}

type stressTeamItemPrivateMemory struct {
	t         *testing.T
	command   *exec.Cmd
	container string
	processID string
	baseline  int64
	peak      atomic.Int64
	done      chan error
	once      sync.Once
}

func stressTeamItemPrivate(t *testing.T, ctx context.Context, container string, backend uint32) *stressTeamItemPrivateMemory {
	t.Helper()
	// The bounded observer reads private mappings, not RSS/shared PostgreSQL
	// buffers. Its own PID is retained so cancellation cannot orphan docker exec.
	script := `printf '%s\n' "$$"; trap 'exit 0' TERM INT; n=0; while [ "$n" -lt 30000 ] && [ -r "/proc/$1/smaps_rollup" ]; do awk '/^Private_Clean:|^Private_Dirty:|^Private_Hugetlb:/ {total += $2} END {print total*1024; fflush()}' "/proc/$1/smaps_rollup"; n=$((n+1)); sleep 0.01; done`
	cmd := exec.CommandContext(ctx, "docker", "exec", "--user", "postgres", container, "sh", "-c", script, "mcp-item-private-memory", strconv.FormatUint(uint64(backend), 10))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ready := false
	observerPID := ""
	defer func() {
		if ready {
			return
		}
		if observerPID != "" {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if output, err := exec.CommandContext(cleanupCtx, "docker", "exec", container, "kill", "-TERM", observerPID).CombinedOutput(); err != nil {
				t.Errorf("stop failed observer: %v %s", err, output)
			}
		}
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		_ = cmd.Wait()
		t.Fatalf("private memory observer did not start: %s", &stderr)
	}
	pid := scanner.Text()
	if n, err := strconv.ParseUint(pid, 10, 32); err != nil || n == 0 {
		t.Fatal("private memory observer returned invalid PID")
	}
	observerPID = pid
	if !scanner.Scan() {
		t.Fatalf("private memory observer did not return a baseline: %s", &stderr)
	}
	baseline, err := strconv.ParseInt(scanner.Text(), 10, 64)
	if err != nil || baseline <= 0 {
		t.Fatalf("private memory baseline: %v", err)
	}
	m := &stressTeamItemPrivateMemory{t: t, command: cmd, container: container, processID: pid, baseline: baseline, done: make(chan error, 1)}
	m.peak.Store(baseline)
	go func() {
		for scanner.Scan() {
			n, err := strconv.ParseInt(scanner.Text(), 10, 64)
			if err != nil {
				m.done <- err
				return
			}
			for old := m.peak.Load(); n > old && !m.peak.CompareAndSwap(old, n); old = m.peak.Load() {
			}
		}
		m.done <- scanner.Err()
	}()
	t.Cleanup(func() { _ = m.finish() })
	ready = true
	return m
}

func (m *stressTeamItemPrivateMemory) finish() int64 {
	m.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if output, err := exec.CommandContext(ctx, "docker", "exec", m.container, "kill", "-TERM", m.processID).CombinedOutput(); err != nil && !m.t.Failed() {
			m.t.Errorf("stop memory observer: %v %s", err, output)
		}
		if err := m.command.Wait(); err != nil && !m.t.Failed() {
			m.t.Errorf("memory observer exit: %v", err)
		}
		if err := <-m.done; err != nil && !m.t.Failed() {
			m.t.Errorf("memory observer scan: %v", err)
		}
	})
	return max(0, m.peak.Load()-m.baseline)
}

type stressTeamItemPeakRange struct {
	minimum, maximum int64
	observed         bool
}

func (r *stressTeamItemPeakRange) observe(t *testing.T, label string, value int64) {
	t.Helper()
	if !r.observed {
		r.minimum, r.maximum, r.observed = value, value, true
	}
	r.minimum = min(r.minimum, value)
	r.maximum = max(r.maximum, value)
	if r.maximum-r.minimum > 4<<20 {
		t.Fatalf("%s peak changes with source length: minimum=%d maximum=%d", label, r.minimum, r.maximum)
	}
}

func TestStressMCPTeamItemCapacityAndReadMemory(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	container := os.Getenv("DAYNIGHT_TEST_POSTGRES_CONTAINER")
	if container == "" {
		t.Fatal("DAYNIGHT_TEST_POSTGRES_CONTAINER must identify the isolated local PostgreSQL container for private-memory sampling")
	}
	mode := os.Getenv("DAYNIGHT_TEST_MCP_ITEM_CACHE_MODE")
	if mode != "restart" && mode != "warm-only" {
		t.Fatal("DAYNIGHT_TEST_MCP_ITEM_CACHE_MODE must be restart (exclusive isolated cluster) or warm-only")
	}
	conditions := []string{"postgres-warm"}
	if mode == "restart" {
		conditions = []string{"postgres-cold", "postgres-warm"}
	}
	base := projectTestStore(t)
	config := base.Pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	db := &postgres.Store{Pool: pool}
	handler := projectTestHandler(t, db, io.Discard)
	team := decodeResponse[api.Team](t, projectRequest(handler, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Capacity", ExpectedUserID: handler.principal.UserID})), 201)
	member, following := uuid.NewString(), uuid.NewString()
	stamp := time.Now().UTC().Truncate(time.Microsecond).Add(time.Second)
	if _, err := pool.Exec(t.Context(), `INSERT INTO users(id,uniauth_id,name,avatar_url,created_at,updated_at) VALUES($1,$2,'initial','',$3,$3),($4,$5,'following','',$3,$3)`, member, "capacity-"+member, stamp, following, "capacity-"+following); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO team_members(team_id,user_id,role,created_at,updated_at) VALUES($1,$2,'member',$4,$4),($1,$3,'member',$4+interval '1 second',$4+interval '1 second')`, team.ID, member, following, stamp); err != nil {
		t.Fatal(err)
	}
	// Keep the slice alive while querying allocator contexts. This supplements
	// live private-mapping samples, which can miss a very short SQL allocation.
	if _, err := pool.Exec(t.Context(), `CREATE FUNCTION mcp_item_memory_probe(target uuid,at_byte integer,amount integer) RETURNS TABLE(field_bytes bigint,memory_bytes bigint) LANGUAGE plpgsql AS $$ DECLARE payload bytea; BEGIN IF amount<0 THEN SELECT octet_length(name_bytes) INTO field_bytes FROM users WHERE id=target; ELSE SELECT substring(name_bytes FROM at_byte+1 FOR amount) INTO payload FROM users WHERE id=target; field_bytes=octet_length(payload); END IF; SELECT sum(total_bytes) INTO memory_bytes FROM pg_backend_memory_contexts; RETURN NEXT; END $$`); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	var incompressible string
	if err := pool.QueryRow(t.Context(), `SELECT string_agg(md5(i::text),'' ORDER BY i) FROM generate_series(1,4096) i`).Scan(&incompressible); err != nil {
		t.Fatal(err)
	}
	patterns := []struct{ name, text string }{{"compressible-utf8", "名😀x"}, {"incompressible-utf8", incompressible}}
	for _, pattern := range patterns {
		contextRange := &stressTeamItemPeakRange{}
		peakRanges := map[string]*stressTeamItemPeakRange{}
		observePeak := func(t *testing.T, condition, metric string, value int64) {
			label := condition + "/" + metric
			if peakRanges[label] == nil {
				peakRanges[label] = &stressTeamItemPeakRange{}
			}
			peakRanges[label].observe(t, label, value)
		}
		for _, size := range []int64{4 << 20, 129 << 20, 900 << 20} {
			t.Run(fmt.Sprintf("%s/%dMiB", pattern.name, size>>20), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
				defer cancel()
				if size%int64(len(pattern.text)) != 0 {
					t.Fatal("source size is not a complete pattern multiple")
				}
				var writeLSN string
				var relationBefore int64
				var writeBackend uint32
				if err := pool.QueryRow(ctx, `SELECT pg_current_wal_insert_lsn()::text,pg_total_relation_size('users'),pg_backend_pid()`).Scan(&writeLSN, &relationBefore, &writeBackend); err != nil {
					t.Fatal(err)
				}
				writeMemory := stressTeamItemPrivate(t, ctx, container, writeBackend)
				writeStarted := time.Now()
				if _, err := pool.Exec(ctx, `UPDATE users SET name=repeat($2,$3),updated_at=updated_at WHERE id=$1`, member, pattern.text, size/int64(len(pattern.text))); err != nil {
					t.Fatal(err)
				}
				writeDuration := time.Since(writeStarted)
				writePrivate := writeMemory.finish()
				var writeWAL string
				var relationAfter int64
				if err := pool.QueryRow(ctx, `SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text,pg_total_relation_size('users')`, writeLSN).Scan(&writeWAL, &relationAfter); err != nil {
					t.Fatal(err)
				}
				t.Logf("fixture_write source=%d duration=%s cluster_wal_bytes=%s relation_before=%d relation_after=%d relation_delta=%d sampled_backend_private_delta=%d", size, writeDuration, writeWAL, relationBefore, relationAfter, relationAfter-relationBefore, writePrivate)
				var sourceBytes, projectionBytes int64
				var compression, sourceCompression *string
				if err := pool.QueryRow(ctx, `SELECT octet_length(name),octet_length(name_bytes),pg_column_compression(name_bytes),pg_column_compression(name) FROM users WHERE id=$1`, member).Scan(&sourceBytes, &projectionBytes, &compression, &sourceCompression); err != nil || sourceBytes != size || projectionBytes != size || compression != nil {
					t.Fatalf("source/projection size or storage: source=%d projection=%d compressed=%v err=%v", sourceBytes, projectionBytes, compression, err)
				}
				if (pattern.name == "compressible-utf8") != (sourceCompression != nil) {
					t.Fatalf("source compression differs from declared pattern: %v", sourceCompression)
				}
				var baselineContext, observedBytes int64
				if err := pool.QueryRow(ctx, `SELECT field_bytes,memory_bytes FROM mcp_item_memory_probe($1,0,-1)`, member).Scan(&observedBytes, &baselineContext); err != nil || observedBytes != size {
					t.Fatalf("inspect allocator probe: bytes=%d error=%v", observedBytes, err)
				}
				maxContext := baselineContext
				for _, offset := range []int64{0, size / 2, size - (512 << 10)} {
					var memory int64
					start := time.Now()
					if err := pool.QueryRow(ctx, `SELECT field_bytes,memory_bytes FROM mcp_item_memory_probe($1,$2,$3)`, member, offset, 512<<10).Scan(&observedBytes, &memory); err != nil || observedBytes != 512<<10 {
						t.Fatalf("slice allocator probe offset=%d bytes=%d: %v", offset, observedBytes, err)
					}
					maxContext = max(maxContext, memory)
					t.Logf("backend allocator offset=%d contexts=%d duration=%s", offset, memory, time.Since(start))
				}
				if delta := maxContext - baselineContext; delta > 16<<20 {
					t.Fatalf("backend slice allocator increase exceeds 16 MiB: %d", delta)
				}
				contextRange.observe(t, "SQL byte-slice allocator", maxContext)
				if mode == "restart" {
					stressTeamItemRestart(t, ctx, pool, container)
				}
				var backend uint32
				if err := pool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&backend); err != nil {
					t.Fatal(err)
				}
				heap := stressTeamItemHeap(t)
				private := stressTeamItemPrivate(t, ctx, container, backend)
				cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStressMCPTeamItemClientProcess$", "-test.v")
				cmd.Env = append(os.Environ(), "DAYNIGHT_MCP_ITEM_CLIENT_PROCESS=1")
				stdin, err := cmd.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				stdout, err := cmd.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				var stderr bytes.Buffer
				cmd.Stderr = &stderr
				if err := cmd.Start(); err != nil {
					t.Fatal(err)
				}
				encoder := json.NewEncoder(stdin)
				if err := encoder.Encode(stressTeamItemConfig{server.URL, handler.token, team.ID, member, following, size, []byte(pattern.text), conditions}); err != nil {
					t.Fatal(err)
				}
				scanner := bufio.NewScanner(stdout)
				var receipt, changed bool
				var privateDelta int64
				maxProbeHeap := map[string]uint64{}
				probeIndex := 0
				finishSample := func(limitHeap uint64, limitPrivate int64) (uint64, int64) {
					deltaHeap, deltaPrivate := heap.finish(), private.finish()
					if deltaHeap > limitHeap || deltaPrivate > limitPrivate {
						t.Fatalf("sample memory threshold: serverGo=%d backendPrivate=%d", deltaHeap, deltaPrivate)
					}
					return deltaHeap, deltaPrivate
				}
				continueClient := func() {
					if err := encoder.Encode(struct{ Continue bool }{true}); err != nil {
						t.Fatal(err)
					}
				}
				for scanner.Scan() {
					line := scanner.Text()
					if strings.HasPrefix(line, "MCP_ITEM_AFTER_INSPECT ") {
						condition := strings.TrimPrefix(line, "MCP_ITEM_AFTER_INSPECT ")
						deltaHeap, deltaPrivate := finishSample(8<<20, 8<<20)
						observePeak(t, condition, "inspect-server-heap", int64(deltaHeap))
						observePeak(t, condition, "inspect-backend-private", deltaPrivate)
						probeIndex = 0
						t.Logf("%s inspect server_heap_delta=%d backend_private_delta=%d", condition, deltaHeap, deltaPrivate)
						continueClient()
					}
					if strings.HasPrefix(line, "MCP_ITEM_BEFORE_PROBE ") || strings.HasPrefix(line, "MCP_ITEM_BEFORE_INSPECT ") || line == "MCP_ITEM_BEFORE_STREAM" {
						heap = stressTeamItemHeap(t)
						private = stressTeamItemPrivate(t, ctx, container, backend)
						continueClient()
					}
					if strings.HasPrefix(line, "MCP_ITEM_AFTER_PROBE ") {
						condition := strings.TrimPrefix(line, "MCP_ITEM_AFTER_PROBE ")
						deltaHeap, deltaPrivate := finishSample(64<<20, 16<<20)
						maxProbeHeap[condition] = max(maxProbeHeap[condition], deltaHeap)
						observePeak(t, condition, fmt.Sprintf("chunk-%d-server-heap", probeIndex), int64(deltaHeap))
						observePeak(t, condition, fmt.Sprintf("chunk-%d-backend-private", probeIndex), deltaPrivate)
						probeIndex++
						t.Logf("%s chunk server_heap_delta=%d backend_private_delta=%d", condition, deltaHeap, deltaPrivate)
						continueClient()
					}
					if line == "MCP_ITEM_BEFORE_CHANGE" {
						_, privateDelta = finishSample(64<<20, 16<<20)
						if _, err := pool.Exec(ctx, `UPDATE users SET name='replacement',updated_at=updated_at WHERE id=$1`, member); err != nil {
							t.Fatal(err)
						}
						if err := encoder.Encode(struct{ Changed bool }{true}); err != nil {
							t.Fatal(err)
						}
						changed = true
					}
					if strings.HasPrefix(line, "MCP_ITEM_RECEIPT ") {
						receipt = true
					}
					t.Log(line)
				}
				_ = stdin.Close()
				waitErr := cmd.Wait()
				if err := scanner.Err(); err != nil || waitErr != nil || !receipt || !changed {
					t.Fatalf("client acceptance failed: scan=%v wait=%v receipt=%v changed=%v stderr=%s", err, waitErr, receipt, changed, &stderr)
				}
				t.Logf("capacity source=%d sampled_chunk_heap_delta=%v backend_private_delta=%d backend_context_delta=%d", size, maxProbeHeap, privateDelta, maxContext-baselineContext)
			})
		}
	}
}

func stressTeamItemRestart(t *testing.T, ctx context.Context, pool *pgxpool.Pool, container string) {
	t.Helper()
	pool.Reset()
	output, err := exec.CommandContext(ctx, "docker", "restart", container).CombinedOutput()
	if err != nil {
		t.Fatalf("restart isolated capacity PostgreSQL: %v %s", err, output)
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var lastError error
	for {
		probeCtx, probeCancel := context.WithTimeout(ctx, 2*time.Second)
		lastError = exec.CommandContext(probeCtx, "docker", "exec", container, "pg_isready", "-U", "daynight", "-d", "daynight_test").Run()
		if lastError == nil {
			lastError = pool.Ping(probeCtx)
		}
		probeCancel()
		if lastError == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatalf("capacity PostgreSQL did not become reachable through the configured fixed host port: %v", lastError)
		case <-ticker.C:
		}
	}
	pool.Reset()
	t.Log("PostgreSQL buffers and backend caches restarted; host OS page cache is not flushed")
}
