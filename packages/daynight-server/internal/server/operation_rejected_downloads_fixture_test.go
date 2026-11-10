package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"testing"
)

type operationRejectedDownloads struct{ t *testing.T }

func (r *operationRejectedDownloads) Read(context.Context, mcptransfer.Actor, mcpdownload.Input) (map[string]any, error) {
	r.t.Errorf("unexpected Downloads.Read call")
	var result0 map[string]any
	return result0, errors.New("unexpected Downloads.Read")
}

func (r *operationRejectedDownloads) ReadAdmitted(context.Context, mcptransfer.Actor, mcpdownload.Input, func(context.Context) error) (map[string]any, error) {
	r.t.Errorf("unexpected Downloads.ReadAdmitted call")
	var result0 map[string]any
	return result0, errors.New("unexpected Downloads.ReadAdmitted")
}
