// Package teamitem defines bounded reads of Team directory item fields.
package teamitem

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const MaxChunkBytes = 512 << 10
const DefaultChunkBytes = 8 << 10

type Target = model.TeamItemTarget
type Authority = model.TeamItemAuthority
type Field = model.TeamItemField
type Metadata = model.TeamItemMetadata

type Input struct {
	Target                  Target
	Action, Revision, Field string
	Offset                  int64
	MaxBytes                int
}
type Result struct {
	Metadata Metadata
	Content  []byte
	Offset   int64
	EOF      bool
}

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }

func LookupError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Team item was not found.", Cause: err}
	}
	return err
}

func Validate(a Authority, in Input) error {
	if err := model.RequirePrincipal(a.Principal); err != nil {
		return err
	}
	if (a.Kind != "pat" && a.Kind != "oauth") || string(a.Principal.Kind) != a.Kind || (a.Kind == "pat" && a.ID != a.Principal.CredentialID) || (a.Kind == "oauth" && (a.Resource == "" || a.Scope == "")) {
		return model.Unauthenticated(nil)
	}
	if id, err := model.CanonicalID(a.ID); err != nil || id != a.ID {
		return model.Unauthenticated(nil)
	}
	for _, id := range []string{in.Target.TeamID} {
		if canonical, err := model.CanonicalID(id); err != nil || canonical != id {
			return invalid("Team ID must be canonical.")
		}
	}
	switch in.Target.Kind {
	case "team":
		if in.Target.UserID != "" || in.Target.ProjectID != "" {
			return invalid("Team item identity is invalid.")
		}
	case "member":
		if canonical, err := model.CanonicalID(in.Target.UserID); err != nil || canonical != in.Target.UserID || in.Target.ProjectID != "" {
			return invalid("Member item identity is invalid.")
		}
	case "project":
		if canonical, err := model.CanonicalID(in.Target.ProjectID); err != nil || canonical != in.Target.ProjectID || in.Target.UserID != "" {
			return invalid("Project item identity is invalid.")
		}
	default:
		return invalid("Item kind is invalid.")
	}
	if in.Action == "inspect" {
		if in.Revision != "" || in.Field != "" || in.Offset != 0 || in.MaxBytes != 0 {
			return invalid("Inspect does not accept chunk parameters.")
		}
		return nil
	}
	if in.Action != "chunk" || in.Revision == "" || len(in.Revision) > 512 || in.Offset < 0 || in.Offset > 1<<30 || in.MaxBytes < 1 || in.MaxBytes > MaxChunkBytes {
		return invalid("Chunk parameters are invalid.")
	}
	return nil
}

func Revision(p model.Principal, target Target, times []time.Time) (string, error) {
	value := struct {
		Kind, Actor, Team, User, Project string
		Times                            []time.Time
	}{target.Kind, p.UserID, target.TeamID, target.UserID, target.ProjectID, times}
	b, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode item revision: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func Read(ctx context.Context, dao store.TeamItemReader, a Authority, in Input) (Result, error) {
	m, err := dao.Metadata(ctx, a.Principal, in.Target)
	if err != nil {
		return Result{}, LookupError(err)
	}
	m.Revision, err = Revision(a.Principal, in.Target, m.ModifiedAt)
	if err != nil {
		return Result{}, err
	}
	result := Result{Metadata: m, Offset: in.Offset}
	if in.Action == "inspect" {
		return result, nil
	}
	if in.Revision != m.Revision {
		return Result{}, &model.Fault{Code: "version_conflict", Message: "The item changed; inspect it again and discard previously read fields."}
	}
	var field *Field
	for i := range m.Fields {
		if m.Fields[i].Name == in.Field {
			field = &m.Fields[i]
			break
		}
	}
	if field == nil || field.IsNull {
		return Result{}, invalid("Field is absent or null.")
	}
	if in.Offset > field.SizeBytes {
		return Result{}, invalid("Offset exceeds the field size.")
	}
	length := min(int64(in.MaxBytes), field.SizeBytes-in.Offset)
	if length == 0 {
		result.Content = []byte{}
		result.EOF = true
		return result, nil
	}
	result.Content, err = dao.FieldBytes(ctx, in.Target, in.Field, in.Offset, int(length))
	if err != nil {
		return Result{}, err
	}
	if int64(len(result.Content)) != length {
		return Result{}, fmt.Errorf("item byte projection length changed in one snapshot")
	}
	result.EOF = in.Offset+length == field.SizeBytes
	return result, nil
}
