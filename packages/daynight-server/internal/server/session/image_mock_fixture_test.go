package session_test

import (
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"reflect"
)

// Only the new resource/closure usecases are adapted here. Unconfigured calls
// remain explicit fixture errors, preserving the existing strict mock boundary.
func (b *routeBackend) wrapResourceCalls(calls sessionhttp.ServiceCallsForTest) sessionhttp.ServiceCallsForTest {
	out := reflect.ValueOf(&calls).Elem()
	for _, name := range []string{"GetImageOccurrence", "RetryImageOccurrence", "BeginHistoryLedgerReserved", "PrepareUpload", "DirectUpload", "WriteUploadChunk", "CompleteUpload", "GetUpload", "ReleaseUpload", "ReadResource", "ImageCapabilities", "ArchivePreparation", "ArchiveFileStatus", "ArchiveTimelineContentReserved"} {
		field := out.FieldByName(name)
		kind := field.Type()
		field.Set(reflect.MakeFunc(kind, func(args []reflect.Value) []reflect.Value {
			b.mu.Lock()
			fn := reflect.ValueOf(b.Funcs).FieldByName(name)
			b.mu.Unlock()
			if e := b.check(name, !fn.IsNil()); e != nil {
				result := make([]reflect.Value, kind.NumOut())
				for i := range result {
					result[i] = reflect.Zero(kind.Out(i))
				}
				result[len(result)-1] = reflect.ValueOf(e)
				return result
			}
			return fn.Call(args)
		}))
	}
	return calls
}
