# -*- coding: utf-8 -*-
"""Bound, checkpointed mesh cleanup. Invoked as a real file by Corvas."""
import io
import json
import math
import os
import time
import traceback
import Rhino
import System

with io.open(os.path.join(os.path.dirname(__file__), 'cleanup-options.json'), 'r', encoding='utf-8') as handle:
    options = json.load(handle)
stage = options['stage']
root = options['resultDirectory']
tag = options['jobId']
report_path = os.path.join(root, 'cleanup-' + stage + '.json')
started = time.time()
doc = Rhino.RhinoDoc.ActiveDoc
report = {'jobId': tag, 'invocationId': options['invocationId'], 'stage': stage, 'status': 'running', 'ok': False, 'outputs': []}


def save():
    report['elapsedSeconds'] = round(time.time() - started, 3)
    with io.open(report_path, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(report, ensure_ascii=False))


def read(name):
    with io.open(os.path.join(root, name), 'r', encoding='utf-8') as handle:
        return json.load(handle)


def mesh_object(object_id):
    obj = doc.Objects.FindId(System.Guid(object_id))
    if obj is None or not isinstance(obj.Geometry, Rhino.Geometry.Mesh):
        raise Exception('Expected source/output mesh no longer exists: ' + object_id)
    return obj


def stats(obj):
    mesh = obj.Geometry
    bounds = mesh.GetBoundingBox(True)
    return {'id': str(obj.Id), 'vertices': mesh.Vertices.Count, 'faces': mesh.Faces.Count,
            'triangles': mesh.Faces.TriangleCount, 'quads': mesh.Faces.QuadCount,
            'valid': mesh.IsValid, 'closed': mesh.IsClosed,
            'bounds': {'min': [bounds.Min.X, bounds.Min.Y, bounds.Min.Z],
                       'max': [bounds.Max.X, bounds.Max.Y, bounds.Max.Z]}}


def layer_index(name):
    index = doc.Layers.FindByFullPath(name, True)
    if index >= 0: return index
    layer = Rhino.DocObjects.Layer()
    layer.Name = name
    return doc.Layers.Add(layer)


def existing(source_id, signature):
    for obj in doc.Objects:
        if (obj.Attributes.GetUserString('corvas.cleanup.job') == tag and
                obj.Attributes.GetUserString('corvas.cleanup.source') == source_id and
                obj.Attributes.GetUserString('corvas.cleanup.stage') == signature):
            if not isinstance(obj.Geometry, Rhino.Geometry.Mesh) or not obj.Geometry.IsValid:
                raise Exception('An existing stage result is invalid; inspect it before rerunning')
            return obj
    return None


def add_result(mesh, original, source_id, signature):
    if mesh is None or not mesh.IsValid or mesh.Faces.Count == 0:
        raise Exception('Cleanup produced an empty or invalid mesh')
    attrs = original.Attributes.Duplicate()
    attrs.LayerIndex = layer_index('Corvas ' + stage + ' ' + tag[:16])
    attrs.Name = 'Corvas ' + stage + ' ' + source_id[:8]
    attrs.SetUserString('corvas.cleanup.job', tag)
    attrs.SetUserString('corvas.cleanup.source', source_id)
    attrs.SetUserString('corvas.cleanup.stage', signature)
    # Derived geometry must not be mistaken for the imported original on retry.
    attrs.SetUserString('corvas.hunyuan.job', None)
    object_id = doc.Objects.AddMesh(mesh, attrs)
    if object_id == System.Guid.Empty: raise Exception('Rhino refused the result mesh')
    return mesh_object(str(object_id))


try:
    save()
    imported = read('import-result.json')
    if not imported.get('ok') or imported.get('jobId') != tag:
        raise Exception('Import report does not belong to this task')
    if doc is None: raise Exception('No active Rhino document')
    sources = [mesh_object(object_id) for object_id in imported['meshIds']]
    if str(doc.RuntimeSerialNumber) != str(imported['documentId']) and not all(
            obj.Attributes.GetUserString('corvas.hunyuan.job') == tag for obj in sources):
        raise Exception('Rhino document changed; open the original document before continuing')
    report['documentId'] = str(doc.RuntimeSerialNumber)
    if stage == 'inspect':
        report['sources'] = [stats(obj) for obj in sources]
    elif stage == 'clean':
        for source in sources:
            source_id = str(source.Id)
            result = existing(source_id, 'clean-v1')
            if result is None:
                work = source.Geometry.DuplicateMesh()
                try:
                    work.Faces.CullDegenerateFaces()
                    work.Vertices.CombineIdentical(True, True)
                    work.Weld(math.radians(35.0))
                    work.UnifyNormals()
                    work.Normals.ComputeNormals()
                    work.Compact()
                    result = add_result(work, source, source_id, 'clean-v1')
                finally:
                    work.Dispose()
            report['outputs'].append({'sourceId': source_id, 'mesh': stats(result)})
            save()
    elif stage == 'quad':
        cleaned = read('cleanup-clean.json')
        if not cleaned.get('ok') or cleaned.get('jobId') != tag:
            raise Exception('Run the clean stage first')
        total_faces = sum(entry['mesh']['faces'] for entry in cleaned['outputs'])
        target = int(options.get('targetQuads') or max(1000, min(60000, round(math.sqrt(total_faces) * 24.0 / 1000.0) * 1000)))
        report['targetQuads'] = target
        for entry in cleaned['outputs']:
            source_id = entry['sourceId']
            clean = mesh_object(entry['mesh']['id'])
            budget = max(50, int(round(float(target) * clean.Geometry.Faces.Count / max(1, total_faces))))
            signature = 'quad-v1-' + str(target)
            result = existing(source_id, signature)
            if result is None:
                params = Rhino.Geometry.QuadRemeshParameters()
                params.TargetQuadCount = budget
                params.AdaptiveQuadCount = True
                params.AdaptiveSize = 60
                params.DetectHardEdges = True
                params.TargetEdgeLength = 0.0
                # Default symmetry is None. Do not impose the old mouse Y-axis preset.
                report['activeSourceId'] = source_id
                save()
                quad = clean.Geometry.QuadRemesh(params)
                if quad is None: raise Exception('QuadRemesh returned no mesh')
                try:
                    quad.Normals.ComputeNormals()
                    quad.Compact()
                    result = add_result(quad, mesh_object(source_id), source_id, signature)
                finally:
                    quad.Dispose()
            report['outputs'].append({'sourceId': source_id, 'budget': budget, 'mesh': stats(result)})
            save()
    elif stage == 'validate':
        quad = read('cleanup-quad.json')
        if not quad.get('ok') or quad.get('jobId') != tag: raise Exception('Run the quad stage first')
        for entry in quad['outputs']:
            output = stats(mesh_object(entry['mesh']['id']))
            if not output['valid'] or not output['quads']: raise Exception('Output is not a valid quad mesh')
            report['outputs'].append({'source': stats(mesh_object(entry['sourceId'])), 'mesh': output})
        report['note'] = 'Geometry counts and validity checked; inspect silhouettes, openings and joints in the viewport.'
    else:
        raise Exception('Unknown cleanup stage')
    report['status'] = 'completed'
    report['ok'] = True
except Exception:
    report['status'] = 'failed'
    report['error'] = traceback.format_exc()
finally:
    save()
    if doc is not None: doc.Views.Redraw()
    print('Corvas cleanup ' + stage + ': ' + report['status'])
