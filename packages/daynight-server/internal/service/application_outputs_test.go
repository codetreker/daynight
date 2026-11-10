package service

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type moduleOutputStore struct{ store.Transactions }

type moduleOutputCapture struct{ t *testing.T }

func (c *moduleOutputCapture) CaptureBatch(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error {
	c.t.Error("module assembly invoked business capture")
	return errors.New("unexpected module capture")
}

// Private consumer fields have no observation API; compare the constructed
// resource graph directly without exporting an assembly-only product API.
func requireModuleDependency(t *testing.T, output any, field string, expected any) {
	t.Helper()
	dependency := reflect.ValueOf(output).Elem().FieldByName(field)
	if dependency.Kind() == reflect.Interface {
		dependency = dependency.Elem()
	}
	want := reflect.ValueOf(expected)
	if !dependency.IsValid() || dependency.Kind() != reflect.Pointer || want.Kind() != reflect.Pointer || dependency.Type() != want.Type() || dependency.Pointer() != want.Pointer() {
		t.Fatalf("%T.%s does not retain the supplied %T instance", output, field, expected)
	}
}

func TestModuleOutputsRetainPrivateTransferDependencies(t *testing.T) {
	newApp := func() (*App, *moduleOutputStore, *local.Storage, *moduleOutputCapture) {
		files, err := local.New(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := files.Close(); err != nil {
				t.Error(err)
			}
		})
		database := &moduleOutputStore{}
		capture := &moduleOutputCapture{t: t}
		app := NewModules(config.Config{PublicOrigin: "https://daynight.test", TaskSyncOverlap: time.Second}, database, nil, files, nil, capture)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := app.Close(ctx); err != nil {
				t.Error(err)
			}
		})
		return app, database, files, capture
	}
	first, firstStore, firstFiles, firstCapture := newApp()
	second, secondStore, secondFiles, secondCapture := newApp()
	if first.PrivateContent == nil || second.PrivateContent == nil || first.PrivateContent == second.PrivateContent || first.Engine == second.Engine || first.Attachments == second.Attachments || first.Downloads == second.Downloads || first.Uploads == second.Uploads {
		t.Fatal("module construction did not retain independent resource and output instances")
	}
	for _, binding := range []struct {
		app     *App
		store   *moduleOutputStore
		files   *local.Storage
		capture *moduleOutputCapture
	}{{first, firstStore, firstFiles, firstCapture}, {second, secondStore, secondFiles, secondCapture}} {
		downloads, ok := binding.app.Downloads.(*mcpdownload.Service)
		if !ok || downloads == nil {
			t.Fatalf("production Downloads = %T", binding.app.Downloads)
		}
		uploads, ok := binding.app.Uploads.(*mcptransfer.Uploads)
		if !ok || uploads == nil {
			t.Fatalf("production Uploads = %T", binding.app.Uploads)
		}
		requireModuleDependency(t, binding.app.Engine, "files", binding.files)
		requireModuleDependency(t, binding.app.Projects, "store", binding.store)
		requireModuleDependency(t, binding.app.Projects, "engine", binding.app.Engine)
		requireModuleDependency(t, binding.app.Tasks, "store", binding.store)
		requireModuleDependency(t, binding.app.Tasks, "capturer", binding.capture)
		requireModuleDependency(t, binding.app.TaskSteps, "store", binding.store)
		requireModuleDependency(t, binding.app.TaskSteps, "capturer", binding.capture)
		requireModuleDependency(t, binding.app.TaskThreads, "store", binding.store)
		requireModuleDependency(t, binding.app.TaskThreads, "capturer", binding.capture)
		requireModuleDependency(t, binding.app.TaskObservations, "database", binding.store)
		requireModuleDependency(t, binding.app.TaskObservations, "observer", binding.app.Engine)
		requireModuleDependency(t, binding.app.TaskInspection, "database", binding.store)
		requireModuleDependency(t, binding.app.TaskInspection, "observer", binding.app.Engine)
		requireModuleDependency(t, binding.app.TaskHistory, "inspection", binding.app.TaskInspection)
		requireModuleDependency(t, binding.app.TaskHistory, "backend", binding.app.Sessions)
		requireModuleDependency(t, binding.app.TaskSync, "store", binding.store)
		requireModuleDependency(t, binding.app.TaskSync, "engine", binding.app.Engine)
		requireModuleDependency(t, binding.app.Attachments, "store", binding.store)
		requireModuleDependency(t, binding.app.Attachments, "mutations", binding.store)
		requireModuleDependency(t, binding.app.Attachments, "files", binding.files)
		requireModuleDependency(t, binding.app.PrivateContent, "db", binding.store)
		requireModuleDependency(t, binding.app.PrivateContent, "files", binding.files)
		requireModuleDependency(t, binding.app.PrivateContent, "private", binding.files)
		requireModuleDependency(t, downloads, "attachments", binding.app.Attachments)
		requireModuleDependency(t, downloads, "lifecycle", binding.app.PrivateContent)
		requireModuleDependency(t, downloads, "files", binding.files)
		requireModuleDependency(t, uploads, "attachments", binding.app.Attachments)
		requireModuleDependency(t, uploads, "lifecycle", binding.app.PrivateContent)
		requireModuleDependency(t, uploads, "files", binding.files)
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		lease, err := binding.app.Attachments.AcquireUploadLease(ctx, model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "credential"}, "33333333-3333-4333-8333-333333333333", "55555555-5555-4555-8555-555555555555")
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if retained := attachment.RetainUploadLease(attachment.WithUploadLeaseRetainer(ctx, func(actual io.Closer) {
			if actual != lease {
				t.Error("upload response retained another lease")
			}
		}), lease); !retained {
			t.Error("upload lease was not retained")
		}
		if err := lease.Close(); err != nil {
			t.Error(err)
		}
		cancel()
	}
}
