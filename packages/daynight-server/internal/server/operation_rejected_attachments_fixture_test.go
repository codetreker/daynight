package server

import (
	"context"
	"errors"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"io"
	"testing"
)

type operationRejectedAttachments struct{ t *testing.T }

func (r *operationRejectedAttachments) List(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error) {
	r.t.Errorf("unexpected Attachments.List call")
	var result0 attachmentcore.Page
	return result0, errors.New("unexpected Attachments.List")
}

func (r *operationRejectedAttachments) PutRetained(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error) {
	r.t.Errorf("unexpected Attachments.PutRetained call")
	var result0 model.Attachment
	var result1 bool
	var result2 io.Closer
	return result0, result1, result2, errors.New("unexpected Attachments.PutRetained")
}

func (r *operationRejectedAttachments) Delete(context.Context, model.Principal, string, string, string) error {
	r.t.Errorf("unexpected Attachments.Delete call")
	return errors.New("unexpected Attachments.Delete")
}

func (r *operationRejectedAttachments) Open(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error) {
	r.t.Errorf("unexpected Attachments.Open call")
	var result0 model.Attachment
	var result1 filestorage.Object
	return result0, result1, errors.New("unexpected Attachments.Open")
}

func (r *operationRejectedAttachments) Put(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, error) {
	r.t.Errorf("unexpected Attachments.Put call")
	var result0 model.Attachment
	var result1 bool
	return result0, result1, errors.New("unexpected Attachments.Put")
}

func (r *operationRejectedAttachments) AdmitTransfer(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (*attachment.TransferAdmission, error) {
	r.t.Errorf("unexpected Attachments.AdmitTransfer call")
	var result0 *attachment.TransferAdmission
	return result0, errors.New("unexpected Attachments.AdmitTransfer")
}

func (r *operationRejectedAttachments) AcquireUploadLease(context.Context, model.Principal, string, string) (io.Closer, error) {
	r.t.Errorf("unexpected Attachments.AcquireUploadLease call")
	var result0 io.Closer
	return result0, errors.New("unexpected Attachments.AcquireUploadLease")
}
