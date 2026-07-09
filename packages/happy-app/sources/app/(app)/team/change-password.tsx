import React from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { changeTeamPassword, getTeamMe } from '@/team/api';

const styles = StyleSheet.create((theme) => ({
    content: {
        flex: 1,
    },
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        textTransform: 'uppercase',
    },
    input: {
        ...Typography.default(),
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 16,
        minHeight: 44,
    },
    copy: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
    error: {
        ...Typography.default(),
        color: theme.colors.textDestructive,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export default function TeamChangePasswordScreen() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const [oldPassword, setOldPassword] = React.useState('');
    const [newPassword, setNewPassword] = React.useState('');
    const [confirmPassword, setConfirmPassword] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const submit = async () => {
        if (!auth.credentials) {
            setError(t('team.signInAgain'));
            return;
        }
        if (newPassword !== confirmPassword) {
            setError(t('team.passwordsDoNotMatch'));
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await changeTeamPassword(auth.credentials, oldPassword, newPassword);
            const me = await getTeamMe(auth.credentials);
            await Modal.alert(t('team.passwordChangedTitle'), t('team.passwordChangedMessage'));
            router.replace(me.user.role === 'ADMIN' ? '/team/admin/users' : '/');
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.passwordChangeFailed'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.changePasswordTitle') }} />
            <KeyboardAvoidingView
                style={styles.content}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList keyboardShouldPersistTaps="handled">
                    <ItemGroup footer={t('team.changePasswordFooter')}>
                        <View style={styles.form}>
                            <Text style={styles.copy}>{t('team.changePasswordIntro')}</Text>
                            <Text style={styles.label}>{t('team.currentPassword')}</Text>
                            <TextInput
                                value={oldPassword}
                                onChangeText={setOldPassword}
                                placeholder={t('team.temporaryPasswordPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={styles.input}
                            />
                            <Text style={styles.label}>{t('team.newPassword')}</Text>
                            <TextInput
                                value={newPassword}
                                onChangeText={setNewPassword}
                                placeholder={t('team.newPasswordPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={styles.input}
                            />
                            <Text style={styles.label}>{t('team.confirmNewPassword')}</Text>
                            <TextInput
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                                placeholder={t('team.confirmPasswordPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                secureTextEntry
                                autoCapitalize="none"
                                autoCorrect={false}
                                style={styles.input}
                            />
                            {error && <Text style={styles.error}>{error}</Text>}
                            <RoundButton
                                title={t('team.updatePassword')}
                                action={submit}
                                loading={loading}
                                disabled={!oldPassword || newPassword.length < 10 || !confirmPassword}
                            />
                        </View>
                    </ItemGroup>
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
