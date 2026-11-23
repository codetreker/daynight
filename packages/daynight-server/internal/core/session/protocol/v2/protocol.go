package v2

import "reflect"

func validNoRecordingEvidence(value, reason any) bool {
	evidence := mapAt(value)
	return unavailableReason(reason) && object(value, fields{"recordingEnabled": boolean, "selectedFrameCount": decimal, "registeredFrameCount": decimal, "captureError": nullable(errorCode)}) && evidence["selectedFrameCount"] == "0" && evidence["registeredFrameCount"] == "0" && evidence["captureError"] == nil && reflect.DeepEqual(evidence["recordingEnabled"], reason == "ended_before_first_sample")
}
