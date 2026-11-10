package redis

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// monitorConnection observes commands executed inside Redis Lua itself. The
// MONITOR acknowledgement is a readiness barrier, not a timing delay.
func monitorConnection(t *testing.T, s *Store) (net.Conn, *bufio.Reader) {
	t.Helper()
	opts := s.client.Options()
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	var conn net.Conn
	var err error
	if opts.TLSConfig != nil {
		conn, err = tls.DialWithDialer(dialer, "tcp", opts.Addr, opts.TLSConfig.Clone())
	} else {
		conn, err = dialer.Dial("tcp", opts.Addr)
	}
	if err != nil {
		t.Fatalf("monitor connection: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	command := func(args ...string) {
		t.Helper()
		if _, err := fmt.Fprintf(conn, "*%d\r\n", len(args)); err != nil {
			t.Fatal(err)
		}
		for _, arg := range args {
			if _, err := fmt.Fprintf(conn, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
				t.Fatal(err)
			}
		}
		line, err := reader.ReadString('\n')
		if err != nil || line != "+OK\r\n" {
			t.Fatalf("monitor setup rejected: %v", err)
		}
	}
	if opts.Password != "" {
		if opts.Username == "" {
			command("AUTH", opts.Password)
		} else {
			command("AUTH", opts.Username, opts.Password)
		}
	}
	if opts.DB != 0 {
		command("SELECT", fmt.Sprint(opts.DB))
	}
	command("MONITOR")
	return conn, reader
}

func TestSummaryReadExecutesOnlyBoundedRedisRanges(t *testing.T) {
	s, id, firstKey := fixture(t)
	ctx := context.Background()
	c := candidate(uuid.NewString(), "1", `{}`)
	if result, err := s.CompareAndSet(ctx, id, nil, c); err != nil || result.Kind != store.MonitoringAccepted {
		t.Fatalf("prepare: %+v %v", result, err)
	}
	absent := store.MonitoringIdentity{UserID: id.UserID, WorkerID: uuid.NewString()}
	secondKey, err := key(absent)
	if err != nil {
		t.Fatal(err)
	}
	_, reader := monitorConnection(t, s)
	result, err := s.ReadSummaries(ctx, []store.MonitoringIdentity{id, absent})
	if err != nil || len(result.Values) != 2 || result.Values[0] == nil || result.Values[0].Body != nil || result.Values[1] != nil {
		t.Fatalf("summary result: %+v %v", result, err)
	}
	marker := uuid.NewString()
	if err := s.client.Echo(ctx, marker).Err(); err != nil {
		t.Fatal(err)
	}
	var first, second, scripts int
	inside := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("monitor did not observe completion marker: %v", err)
		}
		if strings.Contains(line, `"`+marker+`"`) {
			break
		}
		// Redis executes a Lua script atomically. Its MONITOR entries are
		// separate from the EVAL command containing the script source.
		if !strings.Contains(line, " lua] ") {
			inside = strings.Contains(strings.ToLower(line), `"eval"`) && strings.Contains(line, `"`+firstKey+`"`) && strings.Contains(line, `"`+secondKey+`"`)
			if inside {
				scripts++
			}
			continue
		}
		if !inside {
			continue
		}
		lower := strings.ToLower(line)
		if strings.Contains(lower, `"get"`) || strings.Contains(lower, `"scan"`) {
			t.Fatalf("summary read issued forbidden Redis command: %s", line)
		}
		if strings.Contains(lower, `"getrange"`) {
			switch {
			case strings.Contains(line, `"`+firstKey+`" "0" "2047"`):
				first++
			case strings.Contains(line, `"`+secondKey+`" "0" "2047"`):
				second++
			default:
				t.Fatalf("unexpected summary range: %s", line)
			}
		}
	}
	if scripts != 1 || first != 1 || second != 1 {
		t.Fatalf("observed scripts=%d ranges existing=%d absent=%d", scripts, first, second)
	}
}
