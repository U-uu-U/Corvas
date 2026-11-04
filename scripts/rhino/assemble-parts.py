# Assemble imported part meshes into one model from spec.json beside this file.
# Run by scripts/rhino-assemble.mjs through the Rhino MCP (_-RunPythonScript). Works on
# IronPython 2.7 and CPython 3. The source meshes are never modified: each instance is a
# transformed copy on the spec's output layer, and earlier copies on that layer are replaced.
import json
import math
import os
import Rhino
import scriptcontext as sc

HERE = os.path.dirname(os.path.abspath(__file__))
G = Rhino.Geometry
AXES = {'x': G.Vector3d.XAxis, 'y': G.Vector3d.YAxis, 'z': G.Vector3d.ZAxis}


def layer_name(obj):
    return sc.doc.Layers[obj.Attributes.LayerIndex].Name


def objects_on(layer_index):
    # The default object enumeration skips objects on hidden layers; source layers are
    # often hidden so that only the assembly shows.
    settings = Rhino.DocObjects.ObjectEnumeratorSettings()
    settings.NormalObjects = True
    settings.LockedObjects = True
    settings.HiddenObjects = True
    settings.VisibleFilter = False
    settings.LayerIndexFilter = layer_index
    return list(sc.doc.Objects.GetObjectList(settings))


def find_source(part):
    wanted = part.get('layer') or ('Corvas quad ' + part['job'][:16])
    index = sc.doc.Layers.FindByFullPath(wanted, -1)
    if index >= 0:
        for obj in objects_on(index):
            if obj.ObjectType == Rhino.DocObjects.ObjectType.Mesh:
                return obj, wanted
    return None, wanted


def output_layer(name):
    index = sc.doc.Layers.FindByFullPath(name, -1)
    if index < 0:
        layer = Rhino.DocObjects.Layer()
        layer.Name = name
        index = sc.doc.Layers.Add(layer)
    return index


def anchor_point(box, anchor):
    center = box.Center
    z = {'top': box.Max.Z, 'bottom': box.Min.Z}.get(anchor, center.Z)
    return G.Point3d(center.X, center.Y, z)


def box_report(box):
    return {'min': [round(box.Min.X, 2), round(box.Min.Y, 2), round(box.Min.Z, 2)],
            'max': [round(box.Max.X, 2), round(box.Max.Y, 2), round(box.Max.Z, 2)]}


def main():
    spec = json.loads(open(os.path.join(HERE, 'spec.json')).read())
    report = {'ok': True, 'layer': spec['layer'], 'instances': [], 'missing': []}
    layer_index = output_layer(spec['layer'])
    stale = [obj.Id for obj in objects_on(layer_index)]
    for object_id in stale:
        sc.doc.Objects.Delete(object_id, True)
    report['replaced'] = len(stale)
    for part in spec['parts']:
        source, wanted = find_source(part)
        if source is None:
            report['missing'].append({'part': part['name'], 'layer': wanted})
            continue
        mesh = source.Geometry.DuplicateMesh()
        mesh.Transform(G.Transform.Translation(G.Point3d.Origin - mesh.GetBoundingBox(True).Center))
        for axis, degrees in part.get('rotate', []):
            mesh.Transform(G.Transform.Rotation(math.radians(degrees), AXES[axis], G.Point3d.Origin))
        box = mesh.GetBoundingBox(True)
        longest = max(box.Max.X - box.Min.X, box.Max.Y - box.Min.Y, box.Max.Z - box.Min.Z)
        mesh.Transform(G.Transform.Scale(G.Point3d.Origin, float(part['size']) / longest))
        for instance in part['instances']:
            copy = mesh.DuplicateMesh()
            if instance.get('rotateZ'):
                copy.Transform(G.Transform.Rotation(math.radians(instance['rotateZ']), G.Vector3d.ZAxis, G.Point3d.Origin))
            if instance.get('mirrorX'):
                copy.Transform(G.Transform.Mirror(G.Plane.WorldYZ))
            target = G.Point3d(*[float(value) for value in instance['position']])
            copy.Transform(G.Transform.Translation(target - anchor_point(copy.GetBoundingBox(True), instance.get('anchor', 'center'))))
            attributes = Rhino.DocObjects.ObjectAttributes()
            attributes.LayerIndex = layer_index
            attributes.Name = instance['name']
            object_id = sc.doc.Objects.AddMesh(copy, attributes)
            report['instances'].append({'name': instance['name'], 'part': part['name'], 'id': str(object_id),
                                        'bbox': box_report(copy.GetBoundingBox(True))})
    report['ok'] = not report['missing']
    sc.doc.Views.Redraw()
    with open(os.path.join(HERE, 'report.json'), 'w') as handle:
        handle.write(json.dumps(report))


try:
    main()
except Exception as error:
    with open(os.path.join(HERE, 'report.json'), 'w') as handle:
        handle.write(json.dumps({'ok': False, 'error': str(error)}))
