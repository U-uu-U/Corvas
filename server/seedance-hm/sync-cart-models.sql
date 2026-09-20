-- Reconcile the new CNY relay with the approved September 2026 catalog.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE models, billing_rules, channels, model_providers, model_api_providers,
    channel_categories, channel_configs IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
    template models%ROWTYPE;
    billing billing_rules%ROWTYPE;
    channel channels%ROWTYPE;
    item RECORD;
    new_mid TEXT;
    new_billing BIGINT;
    currency TEXT;
    group20 BIGINT;
    api20 BIGINT;
    channel20 BIGINT;
    group25 BIGINT;
    api25 BIGINT;
    channel25 BIGINT;
    backup_group BIGINT;
    backup_api BIGINT;
    backup_channel BIGINT;
BEGIN
    SELECT coalesce((SELECT value::jsonb->>'default_currency' FROM settings WHERE key='currency_settings'), 'CNY') INTO currency;
    IF currency <> 'CNY' THEN RAISE EXCEPTION 'Expected CNY accounting'; END IF;
    SELECT * INTO STRICT template FROM models WHERE model_id='seedance_v2.5' AND is_active=1;
    SELECT * INTO STRICT billing FROM billing_rules WHERE id=template.billing_rule_id;
    SELECT * INTO STRICT channel FROM channels WHERE base_url IN ('https://video.zhubo.asia','https://video.zhubo.asia/v1') AND status=1;
    IF billing.billing_type <> 'requests' OR abs(billing.fixed_rate - 5) > 0.000001
       OR NOT (channel.models::jsonb ? template.mid)
       OR NOT EXISTS (SELECT 1 FROM forward_rules WHERE id IN
           (SELECT jsonb_array_elements_text(template.forward_rule_ids::jsonb)::bigint)
           AND name='Seedance 2.5 OpenAI 异步视频' AND is_active=1) THEN
        RAISE EXCEPTION 'Existing Zhubo route or billing differs from the verified baseline';
    END IF;
    IF EXISTS (SELECT 1 FROM models WHERE model_id='seedance-2.5-pro') THEN
        RAISE EXCEPTION 'Pro already exists; inspect instead of duplicating';
    END IF;
    SELECT id INTO STRICT group25 FROM model_providers WHERE name='其他 SD 视频';
    SELECT id INTO STRICT api25 FROM model_api_providers WHERE name='其他 SD 视频';
    SELECT id INTO STRICT channel25 FROM channel_categories WHERE name='其他 SD 视频';
    SELECT id INTO STRICT backup_group FROM model_providers WHERE name='SD2.5 线路一';
    SELECT id INTO STRICT backup_api FROM model_api_providers WHERE name='SD2.5 线路一';
    SELECT id INTO STRICT backup_channel FROM channel_categories WHERE name='SD2.5 线路一';

    UPDATE model_providers SET name='Seedance 2.5 推荐渠道',name_en='Seedance 2.5 Recommended',sort_order=20,updated_at=now() WHERE id=group25;
    UPDATE model_api_providers SET name='Seedance 2.5 推荐渠道',name_en='Seedance 2.5 Recommended',sort_order=20,updated_at=now() WHERE id=api25;
    UPDATE channel_categories SET name='Seedance 2.5 推荐渠道',name_en='Seedance 2.5 Recommended',sort_order=20,updated_at=now() WHERE id=channel25;
    UPDATE model_providers SET name='Seedance 2.5 备用渠道',name_en='Seedance 2.5 Backup',sort_order=30,updated_at=now() WHERE id=backup_group;
    UPDATE model_api_providers SET name='Seedance 2.5 备用渠道',name_en='Seedance 2.5 Backup',sort_order=30,updated_at=now() WHERE id=backup_api;
    UPDATE channel_categories SET name='Seedance 2.5 备用渠道',name_en='Seedance 2.5 Backup',sort_order=30,updated_at=now() WHERE id=backup_channel;

    INSERT INTO model_providers(name,name_en,sort_order,is_active,is_system,remark)
      VALUES ('Seedance 2.0 推荐渠道','Seedance 2.0 Recommended',100,1,0,'可NSFW 无限制') RETURNING id INTO group20;
    INSERT INTO model_api_providers(name,name_en,sort_order,is_active,is_system,remark)
      VALUES ('Seedance 2.0 推荐渠道','Seedance 2.0 Recommended',100,1,0,'可NSFW 无限制') RETURNING id INTO api20;
    INSERT INTO channel_categories(name,name_en,sort_order,is_active,is_system)
      VALUES ('Seedance 2.0 推荐渠道','Seedance 2.0 Recommended',100,1,0) RETURNING id INTO channel20;

    new_billing := nextval('billing_rules_id_seq');
    SELECT (max(mid::bigint) + 1)::text INTO new_mid FROM models WHERE mid ~ '^[0-9]+$';
    INSERT INTO billing_rules SELECT updated.* FROM jsonb_populate_record(NULL::billing_rules, to_jsonb(billing) || jsonb_build_object(
        'id',new_billing,'pid','','name','Seedance 2.5 Pro CNY 1.06/秒',
        'billing_type','duration','billing_rule','video_resolution','fixed_rate',0,'duration_rate',1.06,
        'pricing_tiers',jsonb_build_array(
            jsonb_build_object('resolution','480p','rate',1.06,'enabled',true,'cached_rate',0),
            jsonb_build_object('resolution','720p','rate',1.06,'enabled',true,'cached_rate',0))::text,
        'extended_config',jsonb_build_object('supported_models',jsonb_build_array('seedance-2.5-pro'),
            'enable_time_multipliers',false,'time_multipliers','[]'::jsonb)::text,
        'created_at',now(),'updated_at',now()
    )) AS updated;
    INSERT INTO models SELECT updated.* FROM jsonb_populate_record(NULL::models, to_jsonb(template) || jsonb_build_object(
        'id',nextval('models_id_seq'),'mid',new_mid,'model_id','seedance-2.5-pro','original_id','seedance-2.5-pro',
        'model_id_alias','','name','Seedance 2.5 Pro（满血满参）','provider_id',group25,'api_provider_id',api25,
        'billing_rule_id',new_billing,'pre_deduction',31.8,'sort_order',2,
        'description','4-30秒；480p/720p；最多30图、10视频、10音频参考；参考视频时长不得超过输出时长；1.06元/秒',
        'remark','Catalog sync 2026-09-21; sale CNY 1.06/second',
        'feature_attributes','["文生视频","图生视频","多模态参考生视频"]','created_at',now(),'updated_at',now()
    )) AS updated;
    UPDATE channels SET name='Seedance 2.5 推荐渠道',category_id=channel25,
        models=(models::jsonb || jsonb_build_array(new_mid))::text,
        model_mapping=(coalesce(nullif(model_mapping,''),'{}')::jsonb || jsonb_build_object('seedance-2.5-pro','seedance-2.5-pro'))::text,
        updated_at=now() WHERE id=channel.id;
    UPDATE channels SET name='Seedance 2.5 备用渠道',category_id=backup_channel,updated_at=now()
      WHERE models::jsonb ? (SELECT mid FROM models WHERE model_id='sd2.5-route1');
    UPDATE channels SET name='Seedance 2.0 推荐渠道',category_id=channel20,updated_at=now()
      WHERE models::jsonb ? (SELECT mid FROM models WHERE model_id='artsdance2-0-fast-intl-260701');
    UPDATE channel_configs SET name='Seedance 2.0 推荐渠道',category_id=channel20,updated_at=now()
      WHERE base_url IN ('https://ai.artsmcp.com','https://ai.artsmcp.com/v1');

    FOR item IN SELECT * FROM (VALUES
        ('sd2.5','SD2.5 固定 30 秒（电商效果优化）',1,group25,api25),
        ('seedance_v2.5','HM-Seedance 2.5',3,group25,api25),
        ('seedance_v2.0-933','HM-Seedance 2.0 933',4,group25,api25),
        ('sd2.5-route1','Seedance 2.5 固定 30 秒（过人脸）',1,backup_group,backup_api),
        ('artsdance2-0-fast-intl-260701','Seedance 2.0 Fast',1,group20,api20),
        ('artsdance2-0-mini-intl-260701','Seedance 2.0 Mini',2,group20,api20),
        ('artsdance2-0-pro-intl-260701','Seedance 2.0 Pro',3,group20,api20)
    ) AS entries(model_id,name,sort_order,provider_id,api_provider_id) LOOP
        UPDATE models SET name=item.name,sort_order=item.sort_order,provider_id=item.provider_id,
            api_provider_id=item.api_provider_id,updated_at=now() WHERE model_id=item.model_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Missing existing model: %',item.model_id; END IF;
    END LOOP;
    UPDATE models SET is_active=0,updated_at=now() WHERE model_id IN (
        'seedance_v2.5-101010','seedance_v2.5-301010',
        'doubao-seedance-2-0-260128','doubao-seedance-2-0-fast','doubao-seedance-2-5-260628');
END $$;
COMMIT;
