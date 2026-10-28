package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func (s *Service) Resource(ctx context.Context, p core.Principal, project, taskID, id, resource string) ([]byte, sp.Resource, error) {
	var descriptor sp.Resource
	if _, err := uuid.Parse(resource); err != nil {
		return nil, descriptor, fault("invalid_input", "Invalid session resource identity.")
	}
	content := []byte{}
	var fence sp.ControllerFence
	var epoch string
	first := true
	for {
		reply, err := s.localContent(ctx, p, project, taskID, id, map[string]any{"kind": "resource", "resourceId": resource, "offset": decimal(int64(len(content))), "limit": sp.MaxContentChunkBytes})
		if err != nil {
			return nil, descriptor, err
		}
		if first {
			fence = reply.snapshot.ControllerFence
			epoch = reply.snapshot.HistoryEpoch
			first = false
		} else if fence != reply.snapshot.ControllerFence || epoch != reply.snapshot.HistoryEpoch {
			return nil, descriptor, fault("reset_required", "The controller connection changed during the resource read.")
		}
		value := reply.result
		if value.Resource == nil || value.Resource.ResourceID != resource || value.Resource.Status != "available" || value.Resource.ByteLength == nil || value.Resource.SHA256 == nil || value.Resource.MediaType == nil {
			return nil, descriptor, fault("not_found", "The controller resource is not available.")
		}
		if len(content) == 0 {
			descriptor = *value.Resource
		} else if string(encode(descriptor)) != string(encode(value.Resource)) {
			return nil, descriptor, fault("resource_conflict", "Resource identity changed between local chunks.")
		}
		chunk, err := base64.StdEncoding.Strict().DecodeString(value.Data)
		expected := number(*descriptor.ByteLength)
		if err != nil || len(chunk) > sp.MaxContentChunkBytes || value.Offset != decimal(int64(len(content))) || expected > sp.MaxResourceBytes || expected < 0 || len(content)+len(chunk) > sp.MaxResourceBytes || int64(len(content)+len(chunk)) > expected || len(chunk) == 0 && !value.EOF {
			return nil, descriptor, fault("resource_conflict", "The controller returned an invalid resource chunk.")
		}
		content = append(content, chunk...)
		if value.EOF {
			digest := sha256.Sum256(content)
			if int64(len(content)) != expected || hex.EncodeToString(digest[:]) != *descriptor.SHA256 {
				return nil, descriptor, fault("resource_conflict", "Resource bytes do not match their local descriptor.")
			}
			return content, descriptor, nil
		}
		if int64(len(content)) == expected {
			return nil, descriptor, fault("resource_conflict", "The controller did not terminate its resource stream.")
		}
	}
}

// Resource bodies belong to the native controller. The former upload endpoint
// cannot turn this online relay back into persistent content storage.
func (s *Service) PutResource(context.Context, string, string, string, []byte) (sp.Resource, error) {
	return sp.Resource{}, fault("not_found", "Session resources are read from the online controller; server uploads are not supported.")
}
