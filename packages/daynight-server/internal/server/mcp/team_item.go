package mcp

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed team_item_tools.json
var teamItemToolsJSON []byte

type teamItemReader interface {
	Read(context.Context, teamitem.Authority, teamitem.Input) (teamitem.Result, error)
}

type teamItemArguments struct {
	Kind      string `json:"kind"`
	Team      string `json:"team"`
	UserID    string `json:"userId"`
	ProjectID string `json:"projectId"`
	Action    string `json:"action"`
	Revision  string `json:"revision"`
	Field     string `json:"field"`
	Offset    string `json:"offset"`
	MaxBytes  *int   `json:"maxBytes"`
	Format    string `json:"format"`
}

type teamItemField struct {
	Field     string `json:"field"`
	IsNull    bool   `json:"isNull"`
	SizeBytes string `json:"sizeBytes"`
}

// RegisterTeamItemTool exposes bounded reads of the complete fields behind a
// Team-list reference. Revision and byte content originate in one read snapshot.
func RegisterTeamItemTool(e *Entry, reader teamItemReader) error {
	if e == nil || reader == nil {
		return errors.New("Team item read dependencies are required")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(teamItemToolsJSON, &definitions); err != nil {
		return fmt.Errorf("decode Team item tool: %w", err)
	}
	if len(definitions) != 1 || definitions[0].Name != "team_item_read" {
		return errors.New("invalid Team item tool definition")
	}
	return e.registerReadTool(definitions[0], func(json.RawMessage) BudgetClass { return BudgetLarge }, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
		if err := ValidateUnicodeFields(raw, "kind", "team", "userId", "projectId", "action", "revision", "field", "offset", "format"); err != nil {
			return ToolResult{}, err
		}
		var args teamItemArguments
		if err := json.Unmarshal(raw, &args); err != nil {
			return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
		}
		input := teamitem.Input{Target: teamitem.Target{Kind: args.Kind, TeamID: args.Team, UserID: args.UserID, ProjectID: args.ProjectID}, Action: args.Action, Revision: args.Revision, Field: args.Field}
		if input.Action == "" {
			input.Action = "inspect"
		}
		if input.Action == "chunk" {
			input.MaxBytes = 8192
			if args.MaxBytes != nil {
				input.MaxBytes = *args.MaxBytes
			}
			offset, err := ParseBytes(args.Offset)
			if err != nil {
				return ToolResult{}, err
			}
			input.Offset = offset
		}
		authority := teamitem.Authority{Principal: actor.Principal, Kind: actor.AuthorityRef.Kind, ID: actor.AuthorityRef.ID, Resource: e.resource, Scope: oauth.Scope}
		result, err := reader.Read(ctx, authority, input)
		refs := map[string]any{"teamId": input.Target.TeamID}
		if input.Target.Kind == "member" {
			refs["userId"] = input.Target.UserID
		}
		if input.Target.Kind == "project" {
			refs["projectId"] = input.Target.ProjectID
		}
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
		if input.Action == "inspect" {
			data, err := teamItemInspection(input.Target.Kind, result.Metadata)
			return ToolResult{Data: data, Refs: refs}, err
		}
		if args.Format == "" {
			args.Format = "text"
		}
		data, err := fitTeamItemChunk(actor, args, result, resultPolicy("team_item_read", raw).maxBytes)
		if err == nil {
			refs["returnedBytes"] = data["readBytes"]
		}
		return ToolResult{Data: data, Refs: refs}, err
	})
}

func teamItemInspection(kind string, metadata teamitem.Metadata) (map[string]any, error) {
	if metadata.Revision == "" || len(metadata.Revision) > 512 {
		return nil, errors.New("invalid Team item revision")
	}
	var header any
	switch kind {
	case "team":
		if metadata.Team == nil {
			return nil, errors.New("Team item header is missing")
		}
		t := metadata.Team
		header = struct {
			ID         string     `json:"id"`
			Kind       string     `json:"kind"`
			Version    string     `json:"version"`
			CreatedAt  time.Time  `json:"createdAt"`
			UpdatedAt  time.Time  `json:"updatedAt"`
			Membership TeamMember `json:"membership"`
		}{t.ID, t.Kind, Decimal(t.Version), t.CreatedAt.UTC(), t.UpdatedAt.UTC(), mapTeamMember(t.Membership)}
	case "member":
		if metadata.Member == nil {
			return nil, errors.New("Team member item header is missing")
		}
		header = mapTeamMember(*metadata.Member)
	case "project":
		if metadata.Project == nil {
			return nil, errors.New("Project item header is missing")
		}
		p := MapProject(*metadata.Project)
		header = struct {
			ID        string           `json:"id"`
			CreatedAt time.Time        `json:"createdAt"`
			UpdatedAt time.Time        `json:"updatedAt"`
			Settings  ProjectSettings  `json:"settings"`
			Ownership ProjectOwnership `json:"ownership"`
		}{p.ID, p.CreatedAt, p.UpdatedAt, p.Settings, p.Ownership}
	default:
		return nil, errors.New("unknown Team item kind")
	}
	fields := make([]teamItemField, 0, len(metadata.Fields))
	for _, field := range metadata.Fields {
		if field.SizeBytes < 0 {
			return nil, errors.New("negative Team item field size")
		}
		fields = append(fields, teamItemField{Field: field.Name, IsNull: field.IsNull, SizeBytes: Decimal(field.SizeBytes)})
	}
	fixed, err := json.Marshal(struct {
		Header any             `json:"header"`
		Fields []teamItemField `json:"fields"`
	}{header, fields})
	if err != nil || len(fixed) > 4<<10 {
		return nil, errors.New("Team item metadata exceeds its fixed projection budget")
	}
	return map[string]any{"projection": "metadata", "contentIncluded": false, "revision": metadata.Revision, "header": header, "fields": fields}, nil
}

func fitTeamItemChunk(actor RequestActor, input teamItemArguments, result teamitem.Result, maxResultBytes int) (map[string]any, error) {
	var size int64 = -1
	for _, field := range result.Metadata.Fields {
		if field.Name == input.Field && !field.IsNull {
			size = field.SizeBytes
		}
	}
	if size < 0 || result.Offset < 0 || result.Offset > size || int64(len(result.Content)) > size-result.Offset || result.Metadata.Revision == "" || len(result.Metadata.Revision) > 512 {
		return nil, errors.New("invalid Team item chunk receipt")
	}
	content := result.Content
	if result.EOF != (result.Offset+int64(len(content)) == size) {
		return nil, errors.New("Team item chunk EOF disagrees with its size")
	}
	if len(content) == 0 && result.Offset != size {
		return nil, errors.New("Team item chunk made no progress")
	}
	if input.Format == "text" && len(content) > 0 {
		if !utf8.RuneStart(content[0]) {
			return nil, &model.Fault{Code: "invalid_input", Message: "Text offset must start at a UTF-8 code point; use base64 for arbitrary byte offsets."}
		}
		n := completeTextPrefix(content)
		if n == 0 {
			return nil, &model.Fault{Code: "invalid_input", Message: "The byte limit cannot fit the next UTF-8 code point."}
		}
		content = content[:n]
	}
	encode := func(n int) map[string]any {
		data := map[string]any{"revision": result.Metadata.Revision, "field": input.Field, "offset": Decimal(result.Offset), "readBytes": Decimal(int64(n)), "nextOffset": Decimal(result.Offset + int64(n)), "sizeBytes": Decimal(size), "eof": result.Offset+int64(n) == size}
		if input.Format == "base64" {
			data["encoding"], data["contentBase64"] = "base64", base64.StdEncoding.EncodeToString(content[:n])
		} else {
			data["encoding"], data["text"] = "utf8", string(content[:n])
		}
		return data
	}
	full := encode(len(content))
	fullSize, err := mirroredResultSize(envelope{Data: full, Meta: &envelopeMeta{RequestID: actor.RequestID}})
	if err != nil || fullSize <= maxResultBytes {
		return full, err
	}
	lo, hi, best := 0, len(content)-1, -1
	for lo <= hi {
		mid := lo + (hi-lo)/2
		n := mid
		if input.Format == "text" {
			n = completeTextPrefix(content[:n])
		}
		data := encode(n)
		size, err := mirroredResultSize(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return nil, err
		}
		if size <= maxResultBytes {
			best = n
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	if best <= 0 {
		return nil, &model.Fault{Code: "payload_too_large", Message: "The response budget cannot fit the next content byte or UTF-8 code point."}
	}
	return encode(best), nil
}

func completeTextPrefix(content []byte) int {
	n := len(content)
	for removed := 0; removed <= utf8.UTFMax && n > 0; removed++ {
		if utf8.Valid(content[:n]) {
			return n
		}
		n--
	}
	return 0
}
