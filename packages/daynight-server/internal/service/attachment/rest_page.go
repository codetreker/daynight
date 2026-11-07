package attachment

import (
	"context"
	"errors"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

// ListREST reads a bounded prefix in one snapshot, measuring the actual wire page.
func (s *Attachments) ListREST(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return attachmentcore.Page{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	query, err := attachmentcore.ListQuery(request, projectID, taskID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	query.Limit, query.MaxPathBytes, query.MaxFieldBytes = 1, attachmentcore.MaxMetadataPageResponseJSONBytes, attachmentcore.MaxMetadataPageResponseJSONBytes
	result := attachmentcore.Page{Items: []model.Attachment{}}
	limitError := func() error {
		return &model.Fault{Code: "resource_limit_exceeded", Message: "Attachment metadata cannot fit in a response page."}
	}
	err = s.read(ctx, principal, projectID, taskID, func(reader store.AttachmentReader) error {
		for len(result.Items) < request.Limit {
			row, err := reader.Attachments(ctx, projectID, taskID, query)
			if err != nil {
				return err
			}
			if len(row.Items) == 0 {
				break
			}
			if len(row.Oversized) > 0 && row.Oversized[0] {
				if len(result.Items) == 0 {
					return limitError()
				}
				break
			}
			items := append(result.Items, row.Items[0])
			candidate, err := attachmentcore.MakePage(store.AttachmentPage{Items: items, HasMore: row.HasMore}, projectID, taskID)
			if err != nil {
				return err
			}
			wire := api.AttachmentPage{Items: make([]api.Attachment, 0, len(items)), NextCursor: candidate.NextCursor}
			for _, item := range items {
				wire.Items = append(wire.Items, attachmentprotocol.REST(item))
			}
			_, encodeErr := measure.JSON(io.Discard, "attachment page", attachmentcore.MaxMetadataPageResponseJSONBytes, wire, true)
			var violation *limit.Violation
			if encodeErr != nil && !errors.As(encodeErr, &violation) {
				return encodeErr
			}
			if encodeErr != nil || (candidate.NextCursor != nil && len(*candidate.NextCursor) > transport.MaxEncodedCursorBytes) {
				if len(result.Items) == 0 {
					return limitError()
				}
				break
			}
			result = candidate
			if !row.HasMore {
				break
			}
			query.After = &row.Items[0].Path
		}
		return nil
	})
	if err != nil {
		return attachmentcore.Page{}, err
	}
	return result, nil
}
