package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type boundAdmissionWriter struct {
	t       *testing.T
	ctx     context.Context
	failure error
	calls   int
}

func (w *boundAdmissionWriter) WriteIdentity(ctx context.Context, _ func(store.IdentityScope) error) (store.Completion, error) {
	if ctx != w.ctx {
		w.t.Fatal("bound admission context changed")
	}
	w.calls++
	return store.Completion{Outcome: store.TransactionNotCommitted}, w.failure
}
func sameFunction(t *testing.T, got, want any) {
	t.Helper()
	if reflect.ValueOf(got).Pointer() != reflect.ValueOf(want).Pointer() {
		t.Fatal("wrong default Core operation binding")
	}
}
func TestNewClientsBindsDefaultOperationsAndAdmissionInstance(t *testing.T) {
	f := newOAuthFixture(t)
	a := &boundAdmissionWriter{t: t, ctx: f.ctx, failure: errors.New("first admission")}
	b := &boundAdmissionWriter{t: t, ctx: f.ctx, failure: errors.New("second admission")}
	first, err := NewClients(f, core.PublicAdmission{Writer: a}, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewClients(f, core.PublicAdmission{Writer: b}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.writer != f || second.writer != f || first.fetch == nil || first.now == nil {
		t.Fatal("constructor wiring incomplete")
	}
	sameFunction(t, first.operations.parseMetadata, core.ParseClientMetadata)
	sameFunction(t, first.operations.parseStoredMetadata, core.ParseStoredClientMetadata)
	sameFunction(t, first.operations.freezeClient, core.FreezeClient)
	for _, item := range []struct {
		c    *Clients
		want error
	}{{first, a.failure}, {second, b.failure}, {first, a.failure}} {
		_, err := item.c.operations.take(f.ctx, "register", "source", "")
		if err != item.want {
			t.Fatal("admission receiver changed", err)
		}
	}
	f.equal(a.calls, 2)
	f.equal(b.calls, 1)
}
func TestNewClientsCoordinatesPreregistrationParsing(t *testing.T) {
	t.Run("complete configured results", func(t *testing.T) {
		f := newOAuthFixture(t)
		ops := rejectClientOperations(f)
		seen := map[string]bool{}
		raw := map[string][]byte{"first": []byte("first raw"), "second": []byte("second raw")}
		metadata := map[string]core.ClientMetadata{"first": {ClientID: "first", ClientName: "one", RedirectURIs: []string{"https://first.example/cb"}, TokenEndpointAuthMethod: "none"}, "second": {ClientID: "second", ClientName: "two", RedirectURIs: []string{"https://second.example/cb"}, TokenEndpointAuthMethod: "none"}}
		ops.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
			f.equal(data, raw[id])
			if seen[id] {
				t.Fatal("parsed configured client twice")
			}
			seen[id] = true
			return cloneClientMetadata(metadata[id]), nil
		}
		c, err := newClients(f, cloneMetadataDocuments(raw), ops)
		if err != nil {
			t.Fatal(err)
		}
		f.equal(c.preregistered, metadata)
		f.equal(len(seen), 2)
	})
	t.Run("parser error suppresses instance", func(t *testing.T) {
		f := newOAuthFixture(t, "parse")
		ops := rejectClientOperations(f)
		failure := errors.New("configured parse failed")
		raw := []byte(`{"client_id":"known","redirect_uris":["https://client.example/cb"]}`)
		ops.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
			f.step("parse")
			f.equal(data, raw)
			f.equal(id, "wrong")
			return core.ClientMetadata{ClientName: "partial"}, failure
		}
		c, err := newClients(f, map[string][]byte{"wrong": bytes.Clone(raw)}, ops)
		if c != nil || err != failure {
			t.Fatal(c, err)
		}
	})
	t.Run("empty key", func(t *testing.T) {
		f := newOAuthFixture(t)
		c, err := newClients(f, map[string][]byte{"": []byte("raw")}, rejectClientOperations(f))
		if c != nil || err != core.ErrInvalidClientMetadata {
			t.Fatal(c, err)
		}
	})
}
func TestClientsRegistrationUsesAdmissionAndConfirmedInsert(t *testing.T) {
	for _, mode := range []string{"success", "capacity", "insert error", "writer error", "not committed", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newOAuthFixture(t, "take", "parse", "writer client", "scope client", "insert client", "callback returned", "writer returned")
			c := f.clients()
			raw := []byte(`{"client_name":"client","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`)
			metadata := core.ClientMetadata{ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}
			failure := errors.New("registration storage failed")
			c.now = func() time.Time { return f.now.In(time.FixedZone("local", 9*3600)) }
			c.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
				f.context(ctx)
				f.step("take")
				f.equal([]string{kind, source, id}, []string{"register", "registration", ""})
				return true, nil
			}
			c.operations.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
				f.step("parse")
				f.equal(data, raw)
				f.equal(id, "")
				return cloneClientMetadata(metadata), nil
			}
			var insertedMetadata core.ClientMetadata
			f.client.insert = func(record store.OAuthClient, limit int, now time.Time) (bool, error) {
				f.equal(limit, 10000)
				f.equal(now, f.now)
				if !secret.Valid(record.ID, "dnoac_") {
					t.Fatal("invalid allocated client identity")
				}
				want := metadata
				want.ClientID = record.ID
				encoded, _ := json.Marshal(want)
				f.equal(record, store.OAuthClient{ID: record.ID, Metadata: encoded, CreatedAt: f.now, LastUsedAt: f.now, ExpiresAt: f.now.Add(7 * 24 * time.Hour)})
				insertedMetadata = want
				if mode == "insert error" {
					return false, failure
				}
				return mode != "capacity", nil
			}
			outcome := store.TransactionCommitted
			var callbackError, finalError error
			switch mode {
			case "insert error":
				callbackError = failure
				finalError = failure
			case "writer error":
				finalError = failure
			case "not committed":
				outcome = store.TransactionNotCommitted
			case "unknown":
				outcome = store.TransactionUnknown
			}
			f.plan("client", true, callbackError, outcome, finalError)
			got, err := c.Register(f.ctx, "registration", bytes.Clone(raw))
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, insertedMetadata)
			} else {
				f.equal(got, core.ClientMetadata{})
				if err == nil {
					t.Fatal("failed registration returned success")
				}
				if mode == "capacity" && !errors.Is(err, ErrClientCapacity) {
					t.Fatal(err)
				}
				if finalError != nil && err != finalError {
					t.Fatal("writer error identity changed", err)
				}
			}
		})
	}
}
func TestClientsRegistrationStopsAtAdmissionOrParserRefusal(t *testing.T) {
	for _, mode := range []string{"admission error", "rate limit", "parser error"} {
		t.Run(mode, func(t *testing.T) {
			steps := []string{"take"}
			if mode == "parser error" {
				steps = append(steps, "parse")
			}
			f := newOAuthFixture(t, steps...)
			c := f.clients()
			failure := errors.New("admission storage failed")
			raw := []byte(`{}`)
			admissionSource := "limited"
			if mode == "parser error" {
				raw = []byte(`{"redirect_uris":[],"token_endpoint_auth_method":"client_secret_basic"}`)
				admissionSource = "bad"
			}
			c.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
				f.context(ctx)
				f.step("take")
				f.equal([]string{kind, source, id}, []string{"register", admissionSource, ""})
				if mode == "admission error" {
					return false, failure
				}
				return mode != "rate limit", nil
			}
			c.operations.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
				f.step("parse")
				f.equal(data, raw)
				f.equal(id, "")
				return core.ClientMetadata{}, core.ErrInvalidClientMetadata
			}
			got, err := c.Register(f.ctx, admissionSource, bytes.Clone(raw))
			f.equal(got, core.ClientMetadata{})
			want := error(core.ErrInvalidClientMetadata)
			if mode == "admission error" {
				want = failure
			}
			if mode == "rate limit" {
				want = core.ErrRateLimited
			}
			checkAuthorizationError(t, err, want)
		})
	}
	t.Run("ten parser refusals still take admission", func(t *testing.T) {
		var steps []string
		for i := 0; i < 10; i++ {
			steps = append(steps, "take", "parse")
		}
		steps = append(steps, "take")
		f := newOAuthFixture(t, steps...)
		c := f.clients()
		allowed := []bool{true, true, true, true, true, true, true, true, true, true, false}
		c.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
			f.context(ctx)
			f.step("take")
			f.equal([]string{kind, source, id}, []string{"register", "limited", ""})
			v := allowed[0]
			allowed = allowed[1:]
			return v, nil
		}
		c.operations.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
			f.step("parse")
			f.equal(data, []byte(`{}`))
			f.equal(id, "")
			return core.ClientMetadata{}, core.ErrInvalidClientMetadata
		}
		for i := 0; i < 10; i++ {
			_, err := c.Register(f.ctx, "limited", []byte(`{}`))
			checkAuthorizationError(t, err, core.ErrInvalidClientMetadata)
		}
		_, err := c.Register(f.ctx, "limited", []byte(`{"redirect_uris":["https://client.example/cb"]}`))
		checkAuthorizationError(t, err, core.ErrRateLimited)
		f.equal(len(allowed), 0)
	})
}
func TestClientsResolveRejectsInvalidIDsBeforeDependencies(t *testing.T) {
	for _, id := range []string{"", "bad\x00id", string([]byte{0xff})} {
		f := newOAuthFixture(t)
		got, err := f.clients().Resolve(f.ctx, id, "http://127.0.0.1:456/cb")
		f.equal(got, core.ValidatedClient{})
		checkAuthorizationError(t, err, core.ErrInvalidClient)
	}
}
func TestClientsResolvePreregisteredUsesControlledFreeze(t *testing.T) {
	f := newOAuthFixture(t, "freeze")
	c := f.clients()
	metadata := core.ClientMetadata{ClientID: "known", RedirectURIs: []string{"https://client.example/cb"}, TokenEndpointAuthMethod: "none"}
	c.preregistered["known"] = cloneClientMetadata(metadata)
	want := fixtureClient()
	want.ClientID = metadata.ClientID
	want.ClientName = metadata.ClientName
	want.Redirects = append([]string(nil), metadata.RedirectURIs...)
	want.MetadataDeadline = time.Time{}
	want.Provenance = "preregistered"
	c.operations.freezeClient = func(id, provenance string, m core.ClientMetadata, deadline time.Time, redirect string) (core.ValidatedClient, error) {
		f.step("freeze")
		f.equal([]string{id, provenance, redirect}, []string{"known", "preregistered", "https://client.example/cb"})
		f.equal(m, metadata)
		f.equal(deadline, time.Time{})
		return cloneValidatedClient(want), nil
	}
	got, err := c.Resolve(f.ctx, "known", "https://client.example/cb")
	if err != nil {
		t.Fatal(err)
	}
	f.equal(got, want)
}
func TestClientsResolveDCRUsesPinnedDeadline(t *testing.T) {
	for _, mode := range []string{"success", "parse error", "freeze error", "pin error", "writer error", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			steps := []string{"writer client", "scope client", "read client", "parse stored"}
			if mode != "parse error" {
				steps = append(steps, "freeze")
			}
			if mode != "parse error" && mode != "freeze error" {
				steps = append(steps, "pin client")
			}
			steps = append(steps, "callback returned", "writer returned")
			f := newOAuthFixture(t, steps...)
			clientID := fixtureDCRClientID()
			requestedRedirect := "http://127.0.0.1:456/cb"
			if mode == "freeze error" {
				requestedRedirect = "https://attacker.example/cb"
			}
			c := f.clients()
			failure := errors.New("client operation failed")
			record := store.OAuthClient{ID: clientID, Metadata: []byte(`{"stored":"document"}`), ExpiresAt: f.now.Add(time.Hour)}
			metadata := core.ClientMetadata{ClientID: clientID, ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}
			frozen := fixtureClient()
			frozen.Provenance = "dcr"
			frozen.ClientID = clientID
			frozen.ClientName = metadata.ClientName
			frozen.Redirects = append([]string(nil), metadata.RedirectURIs...)
			frozen.SelectedExactRedirect = requestedRedirect
			frozen.MetadataDeadline = record.ExpiresAt
			f.client.read = func(id string, lock bool) (store.OAuthClient, error) {
				f.equal(id, clientID)
				f.equal(lock, true)
				return record, nil
			}
			c.operations.parseStoredMetadata = func(raw []byte, id string) (core.ClientMetadata, error) {
				f.step("parse stored")
				f.equal(raw, []byte(record.Metadata))
				f.equal(id, clientID)
				if mode == "parse error" {
					return core.ClientMetadata{}, failure
				}
				return cloneClientMetadata(metadata), nil
			}
			c.operations.freezeClient = func(id, provenance string, m core.ClientMetadata, deadline time.Time, redirect string) (core.ValidatedClient, error) {
				f.step("freeze")
				f.equal([]string{id, provenance, redirect}, []string{clientID, "dcr", requestedRedirect})
				f.equal(m, metadata)
				f.equal(deadline, record.ExpiresAt)
				if mode == "freeze error" {
					return core.ValidatedClient{}, core.ErrInvalidClient
				}
				return cloneValidatedClient(frozen), nil
			}
			f.client.pin = func(id string, now time.Time) (store.OAuthClient, error) {
				f.equal(id, clientID)
				f.equal(now, f.now)
				if mode == "pin error" {
					return store.OAuthClient{}, failure
				}
				pinned := record
				pinned.ExpiresAt = f.now.Add(7 * 24 * time.Hour)
				return pinned, nil
			}
			var callbackError, finalError error
			outcome := store.TransactionCommitted
			switch mode {
			case "parse error":
				callbackError = core.ErrInvalidClient
				finalError = core.ErrInvalidClient
			case "freeze error":
				callbackError = core.ErrInvalidClient
				finalError = core.ErrInvalidClient
			case "pin error":
				callbackError = failure
				finalError = failure
			case "writer error":
				finalError = failure
			case "unknown":
				outcome = store.TransactionUnknown
			}
			f.plan("client", true, callbackError, outcome, finalError)
			got, err := c.Resolve(f.ctx, clientID, requestedRedirect)
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				frozen.MetadataDeadline = f.now.Add(7 * 24 * time.Hour)
				f.equal(got, frozen)
			} else {
				f.equal(got, core.ValidatedClient{})
				if err == nil {
					t.Fatal("failure exposed client")
				}
				if finalError != nil && err != finalError {
					t.Fatal(err)
				}
			}
		})
	}
}

type metadataCallback struct {
	call func(context.Context, string, func([]byte) error) ([]byte, time.Time, error)
}

func (m metadataCallback) Fetch(ctx context.Context, id string, validate func([]byte) error) ([]byte, time.Time, error) {
	return m.call(ctx, id, validate)
}
func TestClientsResolveCIMDUsesValidationCallbackAndDeadline(t *testing.T) {
	for _, mode := range []string{"success", "validation error", "fetch error", "caller cancelled", "other storage error"} {
		t.Run(mode, func(t *testing.T) {
			steps := []string{"writer client", "scope client", "read client", "callback returned", "writer returned"}
			if mode != "other storage error" {
				steps = append(steps, "fetch")
				if mode != "fetch error" && mode != "caller cancelled" {
					steps = append(steps, "parse")
				}
				if mode == "success" {
					steps = append(steps, "freeze")
				}
			}
			f := newOAuthFixture(t, steps...)
			requestedID := "https://client.example/meta"
			if mode == "validation error" {
				requestedID = "https://wrong.example/meta"
			}
			c := f.clients()
			failure := errors.New("metadata fetch failed")
			lookupError := error(model.ErrNotFound)
			if mode == "other storage error" {
				lookupError = failure
			}
			f.client.read = func(id string, lock bool) (store.OAuthClient, error) {
				f.equal(id, requestedID)
				f.equal(lock, true)
				return store.OAuthClient{}, lookupError
			}
			f.plan("client", true, lookupError, store.TransactionNotCommitted, lookupError)
			raw := []byte(`{"client_id":"https://client.example/meta","redirect_uris":["https://client.example/cb"]}`)
			metadata := core.ClientMetadata{ClientID: "https://client.example/meta", ClientName: "callback metadata", RedirectURIs: []string{"https://client.example/cb"}, TokenEndpointAuthMethod: "none"}
			deadline := f.now.Add(time.Hour)
			want := fixtureClient()
			want.Provenance = "cimd"
			want.ClientID = metadata.ClientID
			want.ClientName = metadata.ClientName
			want.Redirects = append([]string(nil), metadata.RedirectURIs...)
			want.MetadataDeadline = deadline
			c.operations.parseMetadata = func(data []byte, id string) (core.ClientMetadata, error) {
				f.step("parse")
				f.equal(data, raw)
				f.equal(id, requestedID)
				if mode == "validation error" {
					return core.ClientMetadata{}, core.ErrInvalidClientMetadata
				}
				return cloneClientMetadata(metadata), nil
			}
			c.operations.freezeClient = func(id, provenance string, m core.ClientMetadata, d time.Time, redirect string) (core.ValidatedClient, error) {
				f.step("freeze")
				f.equal([]string{id, provenance, redirect}, []string{metadata.ClientID, "cimd", "https://client.example/cb"})
				f.equal(m, metadata)
				f.equal(d, deadline)
				return cloneValidatedClient(want), nil
			}
			ctx, cancel := context.WithCancel(f.ctx)
			if mode == "caller cancelled" {
				f.ctx = ctx
			}
			defer cancel()
			c.fetch = metadataCallback{call: func(ctx context.Context, id string, validate func([]byte) error) ([]byte, time.Time, error) {
				f.context(ctx)
				f.step("fetch")
				f.equal(id, requestedID)
				if mode == "caller cancelled" {
					cancel()
					return nil, time.Time{}, failure
				}
				if mode == "fetch error" {
					return nil, time.Time{}, failure
				}
				if err := validate(bytes.Clone(raw)); err != nil {
					return nil, time.Time{}, err
				}
				return bytes.Clone(raw), deadline, nil
			}}
			got, err := c.Resolve(f.ctx, requestedID, "https://client.example/cb")
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, want)
			} else {
				f.equal(got, core.ValidatedClient{})
				wantErr := error(core.ErrInvalidClient)
				if mode == "caller cancelled" {
					wantErr = context.Canceled
				}
				if mode == "other storage error" {
					wantErr = failure
				}
				checkAuthorizationError(t, err, wantErr)
			}
		})
	}
}
