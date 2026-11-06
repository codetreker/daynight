package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

var ErrClientCapacity = errors.New("OAuth client capacity reached")

type metadataReader interface {
	Fetch(context.Context, string, func([]byte) error) ([]byte, time.Time, error)
}

// Clients resolves configured, dynamically registered and URL-based clients.
// A single instance shares the network concurrency limit and metadata cache.
type Clients struct {
	writer        store.OAuthClientWriter
	admission     core.PublicAdmission
	fetch         metadataReader
	preregistered map[string]core.ClientMetadata
	now           func() time.Time
}

// NewClients rejects malformed preregistration configuration at startup. The
// map contains full metadata documents with a client_id matching each key.
func NewClients(writer store.OAuthClientWriter, admission core.PublicAdmission, registered map[string][]byte) (*Clients, error) {
	c := &Clients{writer: writer, admission: admission, fetch: NewMetadataFetcher(), preregistered: make(map[string]core.ClientMetadata), now: time.Now}
	for id, data := range registered {
		if id == "" {
			return nil, core.ErrInvalidClientMetadata
		}
		m, err := core.ParseClientMetadata(data, id)
		if err != nil {
			return nil, err
		}
		c.preregistered[id] = m
	}
	return c, nil
}

// Register consumes the persistent registration budget before parsing or allocating.
// It returns the actual public configuration only after a confirmed commit.
func (c *Clients) Register(ctx context.Context, source string, data []byte) (core.ClientMetadata, error) {
	allowed, err := c.admission.Take(ctx, "register", source, "")
	if err != nil {
		return core.ClientMetadata{}, err
	}
	if !allowed {
		return core.ClientMetadata{}, core.ErrRateLimited
	}
	m, err := core.ParseClientMetadata(data, "")
	if err != nil {
		return core.ClientMetadata{}, err
	}
	m.ClientID = secret.Random("dnoac_")
	encoded, err := json.Marshal(m)
	if err != nil {
		return core.ClientMetadata{}, err
	}
	now := c.now().UTC()
	entry := store.OAuthClient{ID: m.ClientID, Metadata: encoded, CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	var inserted bool
	completion, err := c.writer.WriteOAuthClients(ctx, func(scope store.OAuthClientScope) error {
		var err error
		inserted, err = scope.OAuthClientDAO().InsertClient(ctx, entry, 10000, now)
		return err
	})
	if err != nil {
		return core.ClientMetadata{}, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return core.ClientMetadata{}, errors.New("OAuth client registration did not confirm commit")
	}
	if !inserted {
		return core.ClientMetadata{}, ErrClientCapacity
	}
	return m, nil
}

// Resolve selects and freezes a verified redirect. Callers must acquire the
// start budget before invoking this method, including before any network fetch.
func (c *Clients) Resolve(ctx context.Context, id, redirect string) (core.ValidatedClient, error) {
	if id == "" || len(id) > core.MetadataLimit || !utf8.ValidString(id) || strings.ContainsRune(id, 0) {
		return core.ValidatedClient{}, core.ErrInvalidClient
	}
	if m, ok := c.preregistered[id]; ok {
		return core.FreezeClient(id, "preregistered", m, time.Time{}, redirect)
	}
	now := c.now().UTC()
	var result core.ValidatedClient
	completion, err := c.writer.WriteOAuthClients(ctx, func(scope store.OAuthClientScope) error {
		dao := scope.OAuthClientDAO()
		record, err := dao.Client(ctx, id, true)
		if err != nil {
			return err
		}
		m, err := core.ParseStoredClientMetadata(record.Metadata, id)
		if err != nil {
			return core.ErrInvalidClient
		}
		result, err = core.FreezeClient(id, "dcr", m, record.ExpiresAt, redirect)
		if err != nil {
			return err
		}
		record, err = dao.PinClient(ctx, id, now)
		if err != nil {
			return err
		}
		result.MetadataDeadline = record.ExpiresAt
		return nil
	})
	if err == nil {
		if completion.Outcome != store.TransactionCommitted {
			return core.ValidatedClient{}, errors.New("OAuth client lookup did not confirm commit")
		}
		return result, nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return core.ValidatedClient{}, err
	}
	var m core.ClientMetadata
	_, deadline, err := c.fetch.Fetch(ctx, id, func(data []byte) error { var e error; m, e = core.ParseClientMetadata(data, id); return e })
	if err != nil {
		if ctx.Err() != nil {
			return core.ValidatedClient{}, ctx.Err()
		}
		return core.ValidatedClient{}, core.ErrInvalidClient
	}
	return core.FreezeClient(id, "cimd", m, deadline, redirect)
}
