export const RHINO_EDIT_SKILL = Object.freeze({
    id: 'rhino-model-editing', name: 'Rhino 模型编辑', category: 'creative',
    description: '预览、检查和微调模型，保留原件并整理四边面',
    instruction: '当用户要求操作 Rhino 时，使用已连接的 Cordyceps MCP 工具，先读取实际工具 schema 和场景，确认当前文档、单位、所选对象及对象 ID。Rhino 是可编辑的模型预览器。预览或检查请求只读取、截图和调整视角，不擅自更改几何。四边面流程复用 rhino-mesh-to-nurbs 的清理与 QuadRemesh 部分：先检查网格顶点、三角面、四边面、闭合和包围盒；在副本上 CombineIdentical、Weld、UnifyNormals、重算法线并 Compact，再使用 QuadRemesh。优先用户选中的网格；多个候选且未选中时先请用户选择，不能猜。所有处理结果放在新图层，保留原件、原材质及已有建模内容。面数和对称轴应由模型及用户要求决定，不套用某个产品的 Y 轴对称或 45k 面数。未指定时先完成一次适中的四边面预览，检查孔洞、轮廓和主要特征；只有用户提出需求才继续增加密度或转 SubD。默认到四边面为止，不自动转 NURBS/Brep、不清空 Grasshopper、不删除已有图层。重拓扑不保证保留 UV，要明确保留带贴图原件。执行分阶段记录结果和对象 ID，超时后先检查是否已有结果，禁止盲目重发重计算。完成后提供视图截图和实际结果统计，不把生成网格宣称为生产级精确曲面。以上规则仅用于 Rhino 任务，其他创作继续按用户要求进行。'
});

