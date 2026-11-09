package session

import (
	"context"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ImageDecoder consumes the complete image in an isolated decoder process.
// A returned result establishes full decoding, including every animation frame.
type ImageDecoder func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error)

func (s *Engine) SetImageDecoder(decoder ImageDecoder) { s.imageDecoder = decoder }
func (s *Engine) SetMediaLeaseCleanup(cleanup func(context.Context, string, string) error) {
	s.releaseMediaLeaseRun = cleanup
}
func resourceDAO(tx *operationTx) (store.SessionResourceDAO, error) {
	dao, ok := tx.dao.(store.SessionResourceDAO)
	if !ok {
		return nil, fault("component_unsupported", "Session resource storage requires a server upgrade.")
	}
	return dao, nil
}
func BlobAddress(project, owner, session, blobID string) (string, error) {
	n, e := sessionresource.NewNamespace(project, owner, session)
	if e != nil {
		return "", e
	}
	return n.BlobPath(blobID)
}
func (a *Access) SavedResource(ctx context.Context, id string) (store.SessionResourceRecord, error) {
	d, e := resourceDAO(a.tx)
	if e != nil {
		return store.SessionResourceRecord{}, e
	}
	return d.SavedSessionResource(ctx, a.record.Snapshot.SessionID, id)
}
func (a *Access) ListSavedResources(ctx context.Context) ([]store.SessionResourceRecord, error) {
	d, e := resourceDAO(a.tx)
	if e != nil {
		return nil, e
	}
	return d.ListSessionResources(ctx, a.record.Snapshot.SessionID)
}
func (a *Access) AddResourceReference(ctx context.Context, id, kind, reference string) error {
	d, e := resourceDAO(a.tx)
	if e != nil {
		return e
	}
	return d.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: a.record.Snapshot.SessionID, ResourceID: id, Kind: kind, ReferenceID: reference})
}
