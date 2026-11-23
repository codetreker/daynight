package azure

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func (s *Storage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, r io.Reader) (filestorage.FileInfo, error) {
	p, err := n.ObjectPath(id)
	if err != nil {
		return filestorage.FileInfo{}, err
	}
	return s.Put(ctx, transferBucket, p, r)
}
func (s *Storage) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	p, err := n.ObjectPath(id)
	if err != nil {
		return filestorage.Object{}, err
	}
	return s.Open(ctx, transferBucket, p)
}
func (s *Storage) DeleteTransferNamespace(ctx context.Context, n filestorage.TransferNamespace) error {
	if err := n.Validate(); err != nil {
		return err
	}
	return s.sweep(ctx, transferBucket, n.Directory())
}
func (s *Storage) OpenTransferRange(ctx context.Context, n filestorage.TransferNamespace, id string, offset, length int64) (filestorage.Object, error) {
	if offset < 0 || length < 0 {
		return filestorage.Object{}, fmt.Errorf("%w: negative range", filestorage.ErrInvalidAddress)
	}
	p, err := n.ObjectPath(id)
	if err != nil {
		return filestorage.Object{}, err
	}
	name, err := BlobName(transferBucket, p)
	if err != nil {
		return filestorage.Object{}, err
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, err
	}
	client := s.client.NewBlobClient(name)
	props, err := client.GetProperties(ctx, nil)
	if err != nil {
		return filestorage.Object{}, readError(err)
	}
	if props.ContentLength == nil || props.ETag == nil {
		return filestorage.Object{}, errors.New("Azure response lacks length or ETag")
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, err
	}
	size := *props.ContentLength
	if length == 0 || offset >= size {
		return filestorage.Object{Body: gateBody{ctx, io.NopCloser(strings.NewReader(""))}, Info: filestorage.FileInfo{Size: size}}, nil
	}
	count := min(length, size-offset)
	response, err := client.DownloadStream(ctx, &blob.DownloadStreamOptions{Range: blob.HTTPRange{Offset: offset, Count: count}, AccessConditions: &blob.AccessConditions{ModifiedAccessConditions: &blob.ModifiedAccessConditions{IfMatch: props.ETag}}})
	if err != nil {
		return filestorage.Object{}, readError(err)
	}
	if err = filestorage.GateError(ctx); err != nil {
		return filestorage.Object{}, errors.Join(err, response.Body.Close())
	}
	if response.ETag == nil || *response.ETag != *props.ETag {
		return filestorage.Object{}, errors.Join(errors.New("Azure range returned a different ETag"), response.Body.Close())
	}
	return filestorage.Object{Body: gateBody{ctx, response.NewRetryReader(ctx, nil)}, Info: filestorage.FileInfo{Size: size}}, nil
}
func (s *Storage) PublishTransferAttachment(ctx context.Context, n filestorage.TransferNamespace, id string, target filestorage.TransferAttachmentTarget) error {
	if target.Path() == "" {
		return &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: filestorage.ErrInvalidAddress}
	}
	o, err := s.OpenTransfer(ctx, n, id)
	if err != nil {
		return &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: err}
	}
	_, err = s.Put(ctx, "task-attachments", target.Path(), o.Body)
	closeErr := o.Body.Close()
	if err != nil {
		return errors.Join(err, closeErr)
	}
	if closeErr != nil {
		return &filestorage.PublicationError{Outcome: filestorage.Published, Cause: closeErr}
	}
	return nil
}
