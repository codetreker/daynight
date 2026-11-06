package teamitem

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	"github.com/google/uuid"
)

type itemDatabase struct {
	readErr, authErr      error
	reads, authorizations int
}

func (d *itemDatabase) ReadTeamItem(ctx context.Context, fn func(store.TeamItemReader) error) error {
	d.reads++
	if d.readErr != nil {
		return d.readErr
	}
	return fn(itemReader{})
}
func (d *itemDatabase) AuthorizeTeamItem(context.Context, model.TeamItemAuthority, model.TeamItemTarget) error {
	d.authorizations++
	return d.authErr
}

type itemReader struct{}

func (itemReader) Metadata(context.Context, model.Principal, model.TeamItemTarget) (model.TeamItemMetadata, error) {
	return model.TeamItemMetadata{ModifiedAt: []time.Time{time.Unix(1, 0).UTC()}}, nil
}
func (itemReader) FieldBytes(context.Context, model.TeamItemTarget, string, int64, int) ([]byte, error) {
	panic("inspect reached field bytes")
}

func TestReadNeverPublishesResultWithoutCompletedSnapshotAndCurrentAuthority(t *testing.T) {
	id := uuid.NewString()
	a := core.Authority{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: id}, Kind: "pat", ID: id}
	in := core.Input{Target: core.Target{Kind: "team", TeamID: uuid.NewString()}, Action: "inspect"}
	failure := errors.New("snapshot completion failed")
	d := &itemDatabase{readErr: failure}
	result, err := New(d).Read(t.Context(), a, in)
	if err != failure || d.authorizations != 0 || result.Metadata.Revision != "" {
		t.Fatalf("snapshot failure lost or authorized: %#v %v", result, err)
	}
	d = &itemDatabase{authErr: failure}
	result, err = New(d).Read(t.Context(), a, in)
	if err != failure || d.authorizations != 1 || result.Metadata.Revision != "" {
		t.Fatalf("authority failure published result: %#v %v", result, err)
	}
	d = &itemDatabase{}
	result, err = New(d).Read(t.Context(), a, in)
	if err != nil || result.Metadata.Revision == "" || d.reads != 1 || d.authorizations != 1 {
		t.Fatalf("consistent authorized result: %#v %v", result, err)
	}
	d = &itemDatabase{}
	in.Target.TeamID = "bad"
	_, err = New(d).Read(t.Context(), a, in)
	if err == nil || d.reads != 0 || d.authorizations != 0 {
		t.Fatal("invalid identity reached storage")
	}
}
