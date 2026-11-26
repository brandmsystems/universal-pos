DROP TABLE IF EXISTS app.combo_component;
DROP TABLE IF EXISTS app.combo_choice_option;
DROP TRIGGER IF EXISTS combo_choice_group_set_updated_at ON app.combo_choice_group;
DROP TABLE IF EXISTS app.combo_choice_group;

DROP TABLE IF EXISTS app.menu_item_modifier_group;
DROP TRIGGER IF EXISTS modifier_option_set_updated_at ON app.modifier_option;
DROP TABLE IF EXISTS app.modifier_option;
DROP TRIGGER IF EXISTS modifier_group_set_updated_at ON app.modifier_group;
DROP TABLE IF EXISTS app.modifier_group;

DROP TRIGGER IF EXISTS menu_item_set_updated_at ON app.menu_item;
DROP TABLE IF EXISTS app.menu_item;
DROP TRIGGER IF EXISTS menu_category_set_updated_at ON app.menu_category;
DROP TABLE IF EXISTS app.menu_category;

DROP TABLE IF EXISTS app.tax_component;
DROP TRIGGER IF EXISTS tax_class_set_updated_at ON app.tax_class;
DROP TABLE IF EXISTS app.tax_class;
