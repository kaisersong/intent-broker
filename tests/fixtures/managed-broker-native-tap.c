/* Test-only translation unit. Original production facade body is included
 * byte-for-byte; these hooks change only real NAPI acknowledgement points. */
#include <node_api.h>
#include "original-root-io-vfs.h"
static unsigned managed_io_opens, managed_constructor_faults, managed_close_faults;
static int managed_armed(napi_env env,const char *name){
 napi_value global,value,off;bool armed=false;
 if(napi_get_global(env,&global)!=napi_ok||napi_get_named_property(env,global,name,&value)!=napi_ok||napi_get_value_bool(env,value,&armed)!=napi_ok||!armed)return 0;
 napi_get_boolean(env,false,&off);napi_set_named_property(env,global,name,off);return 1;
}
static void managed_throw_original(napi_env env){
 napi_value global,raw;napi_get_global(env,&global);napi_get_named_property(env,global,"__brokerNativeFaultRaw",&raw);napi_throw(env,raw);
}
static napi_status managed_reference(napi_env env,napi_value value,uint32_t count,napi_ref *out){
 napi_status result=napi_create_reference(env,value,count,out);
 if(result==napi_ok&&managed_armed(env,"__brokerNativeConstructorFault")){managed_constructor_faults++;managed_throw_original(env);}
 return result;
}
static napi_status managed_undefined(napi_env env,napi_value *out){
 napi_status result=napi_get_undefined(env,out);
 if(result==napi_ok&&managed_armed(env,"__brokerNativeCloseFault")){managed_close_faults++;managed_throw_original(env);}
 return result;
}
static int managed_open(nr_original_root_vfs *family,sqlite3 **database){
 int result=nr_original_root_vfs_open(family,database);if(result==SQLITE_OK)managed_io_opens++;return result;
}
#define napi_create_reference managed_reference
#define napi_get_undefined managed_undefined
#define nr_original_root_vfs_open managed_open
#define ps_addon_exports original_managed_addon_exports
#include "protected-sqlite-original.c"
#undef ps_addon_exports
#undef nr_original_root_vfs_open
#undef napi_get_undefined
#undef napi_create_reference
static napi_value managed_facts(napi_env env,napi_callback_info info){
 (void)info;napi_value out,value;napi_create_object(env,&out);
 napi_create_uint32(env,managed_io_opens,&value);napi_set_named_property(env,out,"ioOpens",value);
 napi_create_uint32(env,managed_constructor_faults,&value);napi_set_named_property(env,out,"constructorFaults",value);
 napi_create_uint32(env,managed_close_faults,&value);napi_set_named_property(env,out,"closeFaults",value);return out;
}
napi_value ps_addon_exports(napi_env env,napi_value exports){
 napi_value out=original_managed_addon_exports(env,exports);if(!out)return NULL;
 napi_property_descriptor field={.utf8name="readManagedNativeTapFacts",.method=managed_facts};
 if(napi_define_properties(env,out,1,&field)!=napi_ok)return NULL;return out;
}
