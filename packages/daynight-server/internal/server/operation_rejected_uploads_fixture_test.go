package server

import (
	"context"
	"errors"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"testing"
)

type operationRejectedUploads struct{ t *testing.T }

func (r *operationRejectedUploads) Execute(context.Context, transfercore.Actor, string, string, mcptransfer.UploadInput) (map[string]any, error) {
	r.t.Errorf("unexpected Uploads.Execute call")
	var result0 map[string]any
	return result0, errors.New("unexpected Uploads.Execute")
}
