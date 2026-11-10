//go:build webhookfixture

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type schemaGate struct {
	listener    net.Listener
	target      string
	ready       chan string
	release     chan struct{}
	releaseOnce sync.Once
}

var createSchemaPattern = regexp.MustCompile(`CREATE SCHEMA "(webhook_fixture_[a-f0-9]+)"`)

func (g *schemaGate) start() {
	go func() {
		for {
			client, err := g.listener.Accept()
			if err != nil {
				return
			}
			go g.serve(client)
		}
	}()
}
func (g *schemaGate) stop() { g.releaseOnce.Do(func() { close(g.release) }); _ = g.listener.Close() }
func (g *schemaGate) serve(client net.Conn) {
	defer client.Close()
	backend, err := net.DialTimeout("tcp", g.target, 3*time.Second)
	if err != nil {
		return
	}
	defer backend.Close()
	var armed atomic.Bool
	var mu sync.Mutex
	schema := ""
	go func() {
		defer backend.Close()
		buffer := make([]byte, 8192)
		var recent []byte
		for {
			n, e := client.Read(buffer)
			if n > 0 {
				recent = append(recent, buffer[:n]...)
				if len(recent) > 8192 {
					recent = recent[len(recent)-8192:]
				}
				if match := createSchemaPattern.FindSubmatch(recent); len(match) == 2 {
					mu.Lock()
					schema = string(match[1])
					mu.Unlock()
				}
				mu.Lock()
				found := schema != ""
				mu.Unlock()
				if found && bytes.Contains(bytes.ToLower(recent), []byte("commit\x00")) {
					armed.Store(true)
				}
				if _, err := io.Copy(backend, bytes.NewReader(buffer[:n])); err != nil {
					return
				}
			}
			if e != nil {
				return
			}
		}
	}()
	for {
		var hdr [5]byte
		if _, err = io.ReadFull(backend, hdr[:]); err != nil {
			return
		}
		length := int(binary.BigEndian.Uint32(hdr[1:]))
		if length < 4 || length > 1<<20 {
			return
		}
		payload := make([]byte, length-4)
		if _, err = io.ReadFull(backend, payload); err != nil {
			return
		}
		if hdr[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) && armed.CompareAndSwap(true, false) {
			var readyHdr [5]byte
			if _, err = io.ReadFull(backend, readyHdr[:]); err != nil {
				return
			}
			size := int(binary.BigEndian.Uint32(readyHdr[1:]))
			if size < 4 || size > 1<<20 {
				return
			}
			readyBody := make([]byte, size-4)
			if _, err = io.ReadFull(backend, readyBody); err != nil {
				return
			}
			if readyHdr[0] != 'Z' {
				return
			}
			mu.Lock()
			name := schema
			mu.Unlock()
			select {
			case g.ready <- name:
			default:
			}
			<-g.release
			if _, err = io.Copy(client, bytes.NewReader(append(hdr[:], payload...))); err != nil {
				return
			}
			if _, err = io.Copy(client, bytes.NewReader(append(readyHdr[:], readyBody...))); err != nil {
				return
			}
			continue
		}
		if _, err = io.Copy(client, bytes.NewReader(append(hdr[:], payload...))); err != nil {
			return
		}
	}
}

func TestReadinessPipeFailureReportsUnconfirmedCleanup(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	verify, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer verify.Close()
	parsed, err := url.Parse(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gate := &schemaGate{listener: listener, target: parsed.Host, ready: make(chan string, 1), release: make(chan struct{})}
	gate.start()
	defer gate.stop()
	proxied := *parsed
	proxied.Host = listener.Addr().String()
	q := proxied.Query()
	q.Set("sslmode", "disable")
	proxied.RawQuery = q.Encode()
	token, pat, memberToken, memberPAT := secret.Random("dnst_"), secret.Random("dnpat_"), secret.Random("dnst_"), secret.Random("dnpat_")
	cmd := exec.CommandContext(ctx, "go", "run", "-tags", "webhookfixture", ".")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), "DAYNIGHT_TEST_DATABASE_URL="+proxied.String(), "DAYNIGHT_WEBHOOK_FIXTURE_TOKEN="+token, "DAYNIGHT_WEBHOOK_FIXTURE_PAT="+pat, "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN="+memberToken, "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT="+memberPAT)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		gate.stop()
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_ = cmd.Wait()
		}
	})
	if err = stdout.Close(); err != nil {
		t.Fatal(err)
	}
	var schema string
	select {
	case schema = <-gate.ready:
	case <-ctx.Done():
		t.Fatal("schema commit gate timed out")
	}
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = verify.Exec(c, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
	}()
	lock, err := verify.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	marker := pgx.Identifier{schema, "__webhook_fixture_owner"}.Sanitize()
	if _, err = lock.Exec(ctx, "LOCK TABLE "+marker+" IN ACCESS SHARE MODE"); err != nil {
		t.Fatal(err)
	}
	gate.releaseOnce.Do(func() { close(gate.release) })
	if err = cmd.Wait(); err == nil {
		t.Fatal("closed readiness pipe should fail startup")
	}
	msg := stderr.String()
	if !strings.Contains(msg, schema) || !strings.Contains(msg, "cleanup could not be confirmed") {
		t.Fatalf("cleanup failure missing schema: %s", msg)
	}
	for _, credential := range []string{token, pat, memberToken, memberPAT, dbURL} {
		if strings.Contains(msg, credential) {
			t.Fatal("process diagnostics exposed a credential")
		}
	}
	var exists bool
	if err = lock.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	if err = verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists); err != nil || !exists {
		t.Fatalf("expected retained schema exists=%t err=%v", exists, err)
	}
}
