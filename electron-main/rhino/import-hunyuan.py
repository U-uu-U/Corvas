# -*- coding: utf-8 -*-
"""Import one Corvas model without replacing the active document or its selection."""
import io
import json
import os
import traceback
import Rhino
import scriptcontext as sc
import rhinoscriptsyntax as rs

directory = os.path.dirname(os.path.abspath(__file__))
with io.open(os.path.join(directory, 'import-options.json'), 'r', encoding='utf-8') as handle:
    options = json.load(handle)
report_file = os.path.join(directory, 'import-result.json')
result = {'ok': False, 'jobId': options['jobId'], 'objectIds': []}
doc = sc.doc
previous_layer = doc.Layers.CurrentLayerIndex
previous_selection = [obj.Id for obj in doc.Objects.GetSelectedObjects(False, False)]
before = set(obj.Id for obj in doc.Objects)
try:
    existing = [obj for obj in doc.Objects if obj.Attributes.GetUserString('corvas.hunyuan.job') == options['jobId']]
    if existing:
        imported = existing
    else:
        parent = 'Corvas Hunyuan'
        if not rs.IsLayer(parent):
            rs.AddLayer(parent)
        layer = parent + '::' + options['jobId'][:16]
        if not rs.IsLayer(layer):
            rs.AddLayer(options['jobId'][:16], parent=parent)
        rs.CurrentLayer(layer)
        rs.UnselectAllObjects()
        # The file path comes from a local managed FBX download, never from model text.
        source = options['filePath']
        if not os.path.isfile(source) or '"' in source:
            raise Exception('Model file is unavailable')
        ok = rs.Command('_-Import "' + source + '" _Enter', False)
        imported = [obj for obj in doc.Objects if obj.Id not in before]
        # Tag partial imports too, so an interrupted attempt cannot be imported twice.
        for obj in imported:
            attrs = obj.Attributes.Duplicate()
            attrs.SetUserString('corvas.hunyuan.job', options['jobId'])
            doc.Objects.ModifyAttributes(obj.Id, attrs, True)
        if not ok or not imported:
            raise Exception('Rhino did not finish importing the FBX model')
    meshes = [obj for obj in imported if isinstance(obj.Geometry, Rhino.Geometry.Mesh)]
    result.update({'ok': bool(meshes), 'objectIds': [str(obj.Id) for obj in imported],
                   'meshIds': [str(obj.Id) for obj in meshes],
                   'documentId': str(doc.RuntimeSerialNumber), 'units': str(doc.ModelUnitSystem),
                   'faceCount': sum(obj.Geometry.Faces.Count for obj in meshes)})
    if not meshes:
        result['error'] = 'Imported model has no editable meshes'
except Exception:
    result['error'] = traceback.format_exc()
finally:
    doc.Layers.SetCurrentLayerIndex(previous_layer, True)
    rs.UnselectAllObjects()
    for object_id in previous_selection:
        obj = doc.Objects.FindId(object_id)
        if obj: obj.Select(True)
    doc.Views.Redraw()
    with io.open(report_file, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(result, ensure_ascii=False))
