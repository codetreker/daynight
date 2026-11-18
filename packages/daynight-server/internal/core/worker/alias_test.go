package worker

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestNormalizeAliasUnicode(t *testing.T) {
	for _, value := range []string{" \u00a0开发机 👩‍💻\u3000", strings.Repeat("😀", 80), "\ufffd"} {
		got, err := NormalizeAlias(&value)
		if err != nil || got == nil || *got != strings.TrimSpace(value) {
			t.Fatalf("normalize %q: %v %v", value, got, err)
		}
	}
	if got, err := NormalizeAlias(nil); got != nil || err != nil {
		t.Fatalf("clear: %v %v", got, err)
	}
	values := []string{"", " \u00a0\u3000", strings.Repeat("😀", 81), string([]byte{0xff})}
	for _, r := range []rune{0, '\t', '\n', 0x7f, 0x85, 0x2028, 0x2029, 0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff} {
		values = append(values, "a"+string(r)+"b")
	}
	for _, value := range values {
		if _, err := NormalizeAlias(&value); err == nil {
			t.Errorf("accepted forbidden alias %q", value)
		}
	}
	for _, value := range []string{"", "0", "-1", "+1", "01", " 1", "1.0", "9223372036854775808"} {
		if _, err := AliasVersion(value); err == nil {
			t.Errorf("accepted version %q", value)
		}
	}
	for _, value := range []string{"1", "9223372036854775807"} {
		if _, err := AliasVersion(value); err != nil {
			t.Errorf("valid version %q: %v", value, err)
		}
	}
}

type aliasDAO struct {
	t     *testing.T
	read  func(context.Context, string, string) (model.WorkerAlias, error)
	write func(context.Context, string, string, int64, model.WorkerAlias) error
}

func (d aliasDAO) WorkerAlias(ctx context.Context, user, worker string) (model.WorkerAlias, error) {
	if d.read == nil {
		d.t.Fatal("unexpected alias read")
	}
	return d.read(ctx, user, worker)
}
func (d aliasDAO) SetWorkerAlias(ctx context.Context, user, worker string, expected int64, next model.WorkerAlias) error {
	if d.write == nil {
		d.t.Fatal("unexpected alias write")
	}
	return d.write(ctx, user, worker, expected, next)
}

func TestAliasOwnerVersionAndChanges(t *testing.T) {
	p := model.Principal{UserID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential, CredentialID: "c3333333-3333-4333-8333-333333333333"}
	const id = "a1111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		name     string
		current  model.WorkerAlias
		input    *string
		expected int64
		next     model.WorkerAlias
	}{
		{"set", model.WorkerAlias{Version: 1}, new(" \u3000Build 👩‍💻 "), 1, model.WorkerAlias{Value: new("Build 👩‍💻"), Version: 2}},
		{"clear", model.WorkerAlias{Value: new("Build"), Version: 2}, nil, 2, model.WorkerAlias{Version: 3}},
		{"noop", model.WorkerAlias{Value: new("Build"), Version: 2}, new(" Build "), 2, model.WorkerAlias{Value: new("Build"), Version: 2}},
		{"clear noop", model.WorkerAlias{Version: 2}, nil, 2, model.WorkerAlias{Version: 2}},
		{"max noop", model.WorkerAlias{Version: math.MaxInt64}, nil, math.MaxInt64, model.WorkerAlias{Version: math.MaxInt64}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads, writes := 0, 0
			dao := aliasDAO{t: t}
			check := func(ctx context.Context, user, worker string) {
				if ctx != t.Context() || user != p.UserID || worker != id {
					t.Fatalf("scope/context: %s %s", user, worker)
				}
			}
			dao.read = func(ctx context.Context, u, w string) (model.WorkerAlias, error) {
				check(ctx, u, w)
				reads++
				return tc.current, nil
			}
			dao.write = func(ctx context.Context, u, w string, expected int64, next model.WorkerAlias) error {
				check(ctx, u, w)
				writes++
				if expected != tc.expected || !reflect.DeepEqual(next, tc.next) {
					t.Fatalf("CAS: %d %+v", expected, next)
				}
				return nil
			}
			got, err := PutAlias(t.Context(), dao, p, strings.ToUpper(id), tc.expected, tc.input)
			if err != nil || !reflect.DeepEqual(got, tc.next) || reads != 1 || writes != 1 {
				t.Fatalf("result=%+v err=%v reads=%d writes=%d", got, err, reads, writes)
			}
		})
	}
}

func TestAliasRefusalsAndStoreFailures(t *testing.T) {
	const id = "a1111111-1111-4111-8111-111111111111"
	p := model.Principal{UserID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential, CredentialID: "c3333333-3333-4333-8333-333333333333"}
	failure := errors.New("storage failed")
	for _, tc := range []struct {
		name      string
		principal model.Principal
		id        string
		current   model.WorkerAlias
		expected  int64
		value     *string
		readErr   error
		writeErr  error
		code      string
		cause     error
	}{
		{name: "unauthenticated", id: id, code: "unauthenticated"},
		{name: "bad id", principal: p, id: "bad", code: "invalid_input"},
		{name: "bad value", principal: p, id: id, value: new(""), code: "invalid_input"},
		{name: "hidden", principal: p, id: id, readErr: model.ErrNotFound, code: "not_found"},
		{name: "read failure", principal: p, id: id, readErr: failure, cause: failure},
		{name: "stale noop", principal: p, id: id, current: model.WorkerAlias{Version: 2}, expected: 1, code: "version_conflict"},
		{name: "overflow", principal: p, id: id, current: model.WorkerAlias{Version: math.MaxInt64}, expected: math.MaxInt64, value: new("x"), code: "version_conflict"},
		{name: "write failure", principal: p, id: id, current: model.WorkerAlias{Version: 1}, expected: 1, writeErr: failure, cause: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := aliasDAO{t: t}
			if tc.name != "unauthenticated" && tc.name != "bad id" && tc.name != "bad value" {
				dao.read = func(context.Context, string, string) (model.WorkerAlias, error) { return tc.current, tc.readErr }
			}
			if tc.writeErr != nil {
				dao.write = func(context.Context, string, string, int64, model.WorkerAlias) error { return tc.writeErr }
			}
			_, err := PutAlias(t.Context(), dao, tc.principal, tc.id, tc.expected, tc.value)
			var fault *model.Fault
			if tc.code != "" && (!errors.As(err, &fault) || fault.Code != tc.code) {
				t.Fatalf("want %s, got %v", tc.code, err)
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
}
