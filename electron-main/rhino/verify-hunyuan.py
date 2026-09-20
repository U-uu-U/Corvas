# -*- coding: utf-8 -*-
import io
import json
import os
import traceback
import Rhino
import System

with io.open(os.path.join(os.path.dirname(__file__), 'verify-options.json'), 'r', encoding='utf-8') as handle:
    options = json.load(handle)
result = {'ok': False, 'jobId': options['jobId'], 'invocationId': options['invocationId'], 'foundIds': []}
try:
    doc = Rhino.RhinoDoc.ActiveDoc
    if doc is None: raise Exception('No active Rhino document')
    result['documentId'] = str(doc.RuntimeSerialNumber)
    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.HiddenObjects = True
    settings.LockedObjects = True
    result['documentEmpty'] = not any(obj is not None for obj in doc.Objects.GetObjectList(settings))
    for value in options['expectedIds']:
        obj = doc.Objects.FindId(System.Guid(value))
        if obj is not None and isinstance(obj.Geometry, Rhino.Geometry.Mesh) and (
                obj.Attributes.GetUserString('corvas.hunyuan.job') == options['jobId'] or
                obj.Attributes.GetUserString('corvas.cleanup.job') == options['jobId']):
            result['foundIds'].append(value)
    result['ok'] = True
except Exception:
    result['error'] = traceback.format_exc()
with io.open(options['resultFile'], 'w', encoding='utf-8') as handle:
    handle.write(json.dumps(result, ensure_ascii=False))
